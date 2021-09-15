// Copyright 2018-2021 the Deno authors. All rights reserved. MIT license.
import { serve } from "https://deno.land/std/http/server.ts"
import { serveTLS } from "https://deno.land/std/http/server.ts"
import {
  acceptWebSocket,
  isWebSocketCloseEvent,
  isWebSocketPingEvent,
  WebSocket,
} from "https://deno.land/std/ws/mod.ts"
import {Message, messageTypeStoreSet, MessageTypeSpecial, MessageTypeStore, MessageTypeAccumulating, MessageTypeAccumulatingSet} from './Message.ts'

export class ParticipantStore {
  id: string
  socket:WebSocket
  storedMessages = new Map<string, Message>()   //  key=type
  messagesTo:Message[] = []                   //
  period = 2
  setPeriod(period: number){
    this.period = Math.max(1, Math.round(period / 50))
    //console.log(`Set send period of ${period} for pid:${this.id}`)
  }
  pushOrUpdateMessage(msg: Message){
    if (msg.t === MessageTypeAccumulating.CONTENT_UPDATE_REQUEST) {
      //  keep last data for each id
      let mFound = this.messagesTo.findIndex(m => m.t === msg.t && m.p === msg.p)
      let values:any[] = []
      if (mFound >= 0){
        values = JSON.parse(this.messagesTo[mFound].v) as any[]
      }else{
        mFound = this.messagesTo.length
        this.messagesTo.push(msg)
      }
      const vAdd = JSON.parse(msg.v) as any[]
      for (const a of vAdd){
        const vFound = values.findIndex(v => v.id === a.id)
        if (vFound >= 0){
          values[vFound] = a
        }else{
          values.push(a)
        }
      }
      this.messagesTo[mFound].v = JSON.stringify(values)
    }else{
      const found = this.messagesTo.findIndex(m => m.t === msg.t && m.p === msg.p)
      if (found >= 0){
        if (MessageTypeAccumulatingSet.has(msg.t)) {  //  accumurating
          const vOrg = JSON.parse(this.messagesTo[found].v) as any[]
          const vAdd = JSON.parse(msg.v) as any[]
          const vNew = vOrg.concat(vAdd)
          this.messagesTo[found].v = JSON.stringify(vNew)
        } else {  //  overwrite
          this.messagesTo[found] = msg  //  update
        }
      }else{
        this.messagesTo.push(msg)     //  push
      } 
    }
  }
  sendMessages(){
    if (this.messagesTo.length){
      //console.log(`send to ${this.id}`)
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
  participants = new Map<string, ParticipantStore>()  //  key=source pid
  getParticipant(pid: string, sock: WebSocket){
    const found = this.participants.get(pid)
    if (found) { return found }
    const created = new ParticipantStore(pid, sock)
    this.participants.set(pid, created)
    return created
  }
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
  constructor(){
    this.startSendInterval()
  }
  startSendInterval(){
    setInterval(()=>{
      for(const room of this.rooms.values()){
        for(const participant of room.participants.values()){
          if (this.sendCount % participant.period === 0){
            participant.sendMessages()
          }
        }
      }
      this.sendCount ++
      if (this.sendCount === 2*3*5*7*11*13*17*19*23){
        this.sendCount = 0
      }
    }, 50)
  }
}
const rooms = new Rooms();
(window as any).rooms = rooms
interface Socket{
  rid: string
  pid: string
}

async function handleWs(sock: WebSocket) {
  try {
    for await (const ev of sock) {
      if (typeof ev === "string") {
        // text message.
        //  console.log('ws:', ev);
        const msg = JSON.parse(ev) as Message
        if (!msg.p || !msg.r || !msg.t){
          console.error(`Invalid message: ${ev}`)
        }
        const room = rooms.get(msg.r)
        const participant = room.getParticipant(msg.p, sock)
        if (msg.t === MessageTypeSpecial.REQUEST){
          const msgArrays = Array.from(room.participants.values()).filter(remote => remote.id !== participant.id)
            .map(remote => Array.from(remote.storedMessages.values()))
          for(const msgs of msgArrays){
            for(const msg of msgs){
                participant.pushOrUpdateMessage(msg)
            }
          }
        }else if (msg.t === MessageTypeSpecial.REQUEST_TO){
          const pids = JSON.parse(msg.v) as string[]
          //console.log(`REQUEST_TO ${pids}`)
          msg.v = ''
          msg.p = ''
          for(const pid of pids){
            const to = room.participants.get(pid)
            if (to){
              if (to.storedMessages.has(MessageTypeStore.PARTICIPANT_INFO)){
                to.storedMessages.forEach(stored => participant.pushOrUpdateMessage(stored))
                console.log(`Info for ${to.id} found and sent to ${participant.id}.`)
              }else{
                const len = to.messagesTo.length
                to.pushOrUpdateMessage(msg)
                if (len != to.messagesTo.length){
                  console.log(`Info for ${to.id} not found and request sent.`)
                }
              }
            }
          }
        }else if (msg.t === MessageTypeSpecial.SET_PERIOD){
          const period = JSON.parse(msg.v)
          if (period > 0){
            participant.setPeriod(period)
          }
        }else if (msg.t === MessageTypeSpecial.PARTICIPANT_LEFT){
          const pid = JSON.parse(msg.v)
          const participant = room.participants.get(pid)
          participant?.socket.close(0, 'left')
          room.participants.delete(pid)
          //  console.log(`Participant ${pid} left by message from ${participant.id}: ${ev}`);
        }else{ 
          if (messageTypeStoreSet.has(msg.t)){  //  store message if needed
            participant.storedMessages.set(msg.t, msg)
          }
          //  send message to destination or all remotes
          if (msg.d){
            const to = room.participants.get(msg.d)
            if (to){
              to.pushOrUpdateMessage(msg)
            }
          }else{
            const remotes = Array.from(room.participants.values()).filter(remote => remote.id !== participant.id)
            remotes.forEach(remote => remote.pushOrUpdateMessage(msg))
          }
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
              room.participants.delete(participant.id)

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
  }catch(e){
    //  ignore error
  }
  const config=configText ? JSON.parse(configText) : undefined
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
