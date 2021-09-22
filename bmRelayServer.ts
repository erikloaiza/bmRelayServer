import {serve} from "https://deno.land/std/http/server.ts"
import {serveTLS} from "https://deno.land/std/http/server.ts"
import {acceptWebSocket, isWebSocketCloseEvent, isWebSocketPingEvent, WebSocket} from "https://deno.land/std/ws/mod.ts"

import {Message} from './Message.ts'
import {ISharedContent, isContentWallpaper, isEqualSharedContentInfo} from './ISharedContent.ts'
import {MessageType, InstantMessageType, StoredMessageType, InstantMessageKeys, StoredMessageKeys} from './MessageType.ts'
import {getRect, isOverlapped} from './coordinates.ts'

interface SharedContent extends ISharedContent{
  updateTime:number
  updateInfoTime:number
}

interface ParticipantSent{
  participant: ParticipantStore,
  lastSentTime: number 
}
interface ContentSent{
  content: SharedContent,
  lastSentTime: number 
}

export class ParticipantStore {
  id: string
  socket:WebSocket
  storedMessages = new Map<string, Message>()   //  key=type
  messagesTo:Message[] = []                   //
  participantsSent:Map<string, ParticipantSent> = new Map()
  contentsSent:Map<string, ContentSent> = new Map()
  pushOrUpdateMessage(msg: Message){
    const found = this.messagesTo.findIndex(m => m.t === msg.t && m.p === msg.p)
    if (found >= 0){
      this.messagesTo[found] = msg  //  update
    }else{
      this.messagesTo.push(msg)     //  push
    } 
  }
  sendMessages(){
    if (this.messagesTo.length){
      try{
        if (!this.socket.isClosed){
          this.socket.send(JSON.stringify(this.messagesTo))
        }
      }
      catch(e){
        console.error(e)
      }
      this.messagesTo = []
      //console.log(`${this.messagesTo.length} msg sent to ${this.id} v:${JSON.stringify(this.messagesTo)}`)
    }
  }
  
  constructor(id:string, socket:WebSocket){
    this.id = id
    this.socket = socket
  }
}
export class RoomStore {
  id: string  //  room id
  constructor(roomId: string){
    this.id = roomId
  }
  participantsMap = new Map<string, ParticipantStore>()  //  key=source pid
  participants:ParticipantStore[] = []

  getParticipant(pid: string, sock: WebSocket){
    const found = this.participantsMap.get(pid)
    if (found) { return found }
    const created = new ParticipantStore(pid, sock)
    this.participantsMap.set(pid, created)
    this.participants.push(created)
    return created
  }
  onParticipantLeft(participant: ParticipantStore){
    this.participantsMap.delete(participant.id)
    const idx = this.participants.findIndex(p => p === participant)
    this.participants.splice(idx, 1)
    if (this.participantsMap.size === 0){
      this.contents.forEach(c => {
        if (!isContentWallpaper(c)){ this.contents.delete(c.id) }
      })
    }   
  }

  //  room properties
  properties = new Map<string, string>()
  
  //  room contents
  contents = new Map<string, SharedContent>()
//  contents:SharedContent[] = []
}

class Rooms{
  rooms:Map<string, RoomStore> = new Map()
  sendCount = 0;
  get(name: string){
    const found = this.rooms.get(name)
    if (found){
      return found
    }
    const create = new RoomStore(name)
    this.rooms.set(name, create)
    return create
  }
  clear(){
    this.rooms = new Map()
  }
}
const rooms = new Rooms();
(window as any).rooms = rooms

type MessageHandler = (msg: Message, room: RoomStore, sock: WebSocket) => void
const messageHandlers = new Map<string, MessageHandler>()

function instantMessageHandler(msg: Message, room: RoomStore){
  //  send message to destination or all remotes
  //  console.log(`instantMessageHandler ${msg.t}`, msg)
  if (msg.d){
    const to = room.participantsMap.get(msg.d)
    if (to){
      to.pushOrUpdateMessage(msg)
    }
  }else{
    const remotes = Array.from(room.participants.values()).filter(remote => remote.id !== msg.p)
    remotes.forEach(remote => remote.pushOrUpdateMessage(msg))
  }
}
function storedMessageHandler(msg: Message, room: RoomStore, sock: WebSocket){
  //  console.log(`storedMessageHandler ${msg.t}`, msg)
  const participant = room.getParticipant(msg.p, sock)
  participant.storedMessages.set(msg.t, msg)
  instantMessageHandler(msg, room)
}
for(const key in StoredMessageType){
  messageHandlers.set(StoredMessageType[key as StoredMessageKeys], storedMessageHandler)
}
for(const key in InstantMessageType){
  messageHandlers.set(InstantMessageType[key as InstantMessageKeys], instantMessageHandler)
}

messageHandlers.set(MessageType.REQUEST_ALL, (msg, room, sock) => {
  const participant = room.getParticipant(msg.p, sock)
  room.participants.forEach(remote => {
    remote.storedMessages.forEach(msg => participant.pushOrUpdateMessage(msg))
  })
})
messageHandlers.set(MessageType.REQUEST_RANGE, (msg, room, sock) => {
  const range = JSON.parse(msg.v) as number[]
  const participant = room.getParticipant(msg.p, sock)
  const overlaps = Array.from(room.contents.values()).filter(c => isOverlapped(getRect(c.pose, c.size), range))
  const contentsToSend = overlaps.filter(c => {
    const sent = participant.contentsSent.get(c.id)
    if (sent){
      if (sent.lastSentTime < c.updateTime){
        sent.lastSentTime = c.updateTime
        return true
      }else{
        return false
      }
    }
    participant.contentsSent.set(c.id, {content:c, lastSentTime: c.updateTime})
    return true
  })
  //  if (overlaps.length){ console.log(`REQUEST_RANGE overlap:${overlaps.length} send:${contentsToSend.length}`) }
  if (contentsToSend.length){
    const msgToSend = {r:room.id, t:MessageType.CONTENT_UPDATE_REQUEST, p:'', d:'', v:JSON.stringify(contentsToSend)}
    participant.pushOrUpdateMessage(msgToSend)  
    console.log(`Contents ${contentsToSend.map(c=>c.id)} sent.`)  
  }
  participant.sendMessages()
})
messageHandlers.set(MessageType.REQUEST_TO, (msg, room, sock) => {
  const pids = JSON.parse(msg.v) as string[]
  //console.log(`REQUEST_TO ${pids}`)
  const from = msg.p
  msg.v = ''
  msg.p = ''
  for(const pid of pids){
    const to = room.participantsMap.get(pid)
    if (to){
      if (to.storedMessages.has(MessageType.PARTICIPANT_INFO)){
        const participant = room.getParticipant(from, sock)
        to.storedMessages.forEach(stored => participant?.pushOrUpdateMessage(stored))
        console.log(`Info for ${to.id} found and sent to ${participant?.id}.`)
      }else{
        const len = to.messagesTo.length
        to.pushOrUpdateMessage(msg)
        if (len != to.messagesTo.length){
          console.log(`Info for ${to.id} not found and request sent.`)
        }
      }
    }
  }
})
messageHandlers.set(MessageType.PARTICIPANT_LEFT, (msg, room) => {
  const pid = JSON.parse(msg.v) as string
  const participant = room.participantsMap.get(pid ? pid : msg.p)
  if (participant){
    participant.socket.close(1000, 'closed by PARTICIPANT_LEFT message.')
    room.onParticipantLeft(participant)
    console.log(`participant ${msg.p} left. ${room.participants.length} remain.`)
  }else{
    //  console.error(`PARTICIPANT_LEFT can not find pid=${msg.p}`)
  }
})

messageHandlers.set(MessageType.CONTENT_UPDATE_REQUEST, (msg, room, sock) => {
  const cs = JSON.parse(msg.v) as SharedContent[]
  const participant = room.getParticipant(msg.p, sock)
  const time = Date.now()
  for(const c of cs){
    //  upate room's content
    c.updateTime = time
    const old = room.contents.get(c.id)
    if (old && !isEqualSharedContentInfo(old, c)) {
      c.updateInfoTime = time
    }

    room.contents.set(c.id, c)
    //  The sender should not receive the update. 
    participant.contentsSent.set(c.id, {content:c, lastSentTime: c.updateTime})
  }
  console.log(`Contents update ${cs.map(c=>c.id)} at ${time}`)
})

messageHandlers.set(MessageType.CONTENT_REMOVE_REQUEST, (msg, room) => {
  const cids = JSON.parse(msg.v) as string[]
  //   delete contents
  for(const cid of cids){
    room.contents.delete(cid)
  }
  //  forward remove request to all participants
  const remotes = Array.from(room.participants.values()).filter(participant => participant.id !== msg.p)
  remotes.forEach(participant => {
    const cidsForMsg:string[] = []
    for(const cid of cids){
      if (participant.contentsSent.delete(cid)){ cidsForMsg.push(cid) }
    }
    msg.v = JSON.stringify(cidsForMsg)
    participant.pushOrUpdateMessage(msg)
  })
})

async function handleWs(sock: WebSocket) {
  try {
    for await (const ev of sock) {
      if (typeof ev === "string") {
        // text message.
        const msg = JSON.parse(ev) as Message
        if (!msg.r || !msg.t){
          console.error(`Invalid message: ${ev}`)
        }
        //  if (msg.t !== MessageType.REQUEST_RANGE){ console.log('ws:', ev); }
        const room = rooms.get(msg.r)
        const handler = messageHandlers.get(msg.t)
        if (handler){
          handler(msg, room, sock)
        }else{
          console.error(`No message handler for ${msg.t} - ${ev}`)
        }

      } else if (ev instanceof Uint8Array) {
        // binary message.
        console.log("ws:Binary", ev);
      } else if (isWebSocketPingEvent(ev)) {
        const [, body] = ev;
        // ping.
        console.log("ws:Ping", body);
      } else if (isWebSocketCloseEvent(ev)) {
        // onclose: close websocket
        const { code, reason } = ev;
        for(const room of rooms.rooms.values()){
          for(const participant of room.participants.values()){
            if (participant.socket === sock){
              console.warn(`Participant ${participant.id} left by websocket close code:${code}, reason:${reason}.`);
              room.onParticipantLeft(participant)
              return
            }
          }
        }
        if (code!==0 || reason !== 'left'){
          console.log(`websocket close. code:${code}, reason:${reason}`)
        }
      }
    }
  } catch (err) {
    console.error(`Failed to receive frame: ${err}`);
    if (!sock.isClosed) {
      try{
        sock.close(1000).catch(console.error)      //  code 1000 : Normal Closure
      }catch(e){
        console.error(e)
      }
    }
  }
}

if (import.meta.main) {
  /** websocket message relay server */
  
  let configText = undefined
  try{
    configText = Deno.readTextFileSync('./config.json')
  }catch{
    //  ignore error
  }
  const config = configText ? JSON.parse(configText) : undefined
  const port = Deno.args[0] || config?.port || "8443";
  const TLS = Deno.args[1] || config?.tls || false;
  console.log(`Websocket server is running on :${port}${TLS ? ' with TLS' : ''}.`);
  for await (const req of (
    TLS ? serveTLS({port:Number(port), certFile:'./host.crt', keyFile:'./host.key'}) 
      : serve(`:${port}`)
    )) {
    const { conn, r: bufReader, w: bufWriter, headers } = req;
    acceptWebSocket({
      conn,
      bufReader,
      bufWriter,
      headers,
    })
      .then(handleWs)
      .catch(async (err) => {
        console.error(`failed to accept websocket: ${err}`);
        await req.respond({ status: 400 });
      });
  }
}
