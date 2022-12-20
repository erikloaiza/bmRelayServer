import {serve} from "https://deno.land/std@0.115.1/http/server_legacy.ts"
import {serveTLS} from "https://deno.land/std@0.115.1/http/server_legacy.ts"
import {acceptWebSocket, isWebSocketCloseEvent, isWebSocketPingEvent, WebSocket} from "https://deno.land/std@0.115.1/ws/mod.ts"

import {BMMessage as Message} from './BMMessage.ts'
import {extractSharedContentInfo, ISharedContent, isEqualSharedContentInfo} from './ISharedContent.ts'
import {MessageType, InstantMessageType, StoredMessageType, InstantMessageKeys, StoredMessageKeys, 
  ParticipantMessageType, ParticipantMessageKeys} from './MessageType.ts'
import {getRect, isOverlapped, isOverlappedToCircle, isInRect, isInCircle, str2Mouse, str2Pose} from './coordinates.ts'

import {Content, messageHandlers, rooms, RoomStore, ParticipantStore, createContentSent, updateContentSent} from './Stores.ts'


//auth dependencies
import { GoogleOAuth2 } from "https://deno.land/x/google/oauth2.ts";


function instantMessageHandler(msg: Message, from:ParticipantStore, room: RoomStore){
  //  send message to destination or all remotes
  //  console.log(`instantMessageHandler ${msg.t}`, msg)
  msg.p = from.id
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
function storedMessageHandler(msg: Message, from: ParticipantStore, room: RoomStore){
  //  console.log(`storedMessageHandler ${msg.t}`, msg)
  msg.p = from.id
  from.storedMessages.set(msg.t, msg)
  instantMessageHandler(msg, from, room)
}
function participantMessageHandler(msg: Message, from: ParticipantStore, room: RoomStore){
  from.participantStates.set(msg.t, {type:msg.t, updateTime: room.tick, value:msg.v})
}
for(const key in StoredMessageType){
  messageHandlers.set(StoredMessageType[key as StoredMessageKeys], storedMessageHandler)
}
for(const key in InstantMessageType){
  messageHandlers.set(InstantMessageType[key as InstantMessageKeys], instantMessageHandler)
}
for(const key in ParticipantMessageType){
  messageHandlers.set(ParticipantMessageType[key as ParticipantMessageKeys], participantMessageHandler)
}

messageHandlers.set(MessageType.PARTICIPANT_POSE, (msg, from, room) => {
  //  console.log(`str2Pose(${msg.v}) = ${JSON.stringify(str2Pose(JSON.parse(msg.v)))}`)
  //  set pose
  from.pose = str2Pose(JSON.parse(msg.v))
  //  also set the message as one of the state of the participant.
  from.participantStates.set(msg.t, {type:msg.t, value:msg.v, updateTime:room.tick})
})
messageHandlers.set(MessageType.PARTICIPANT_ON_STAGE, (msg, from, room) => {
  from.onStage = JSON.parse(msg.v)
  from.participantStates.set(msg.t, {type:msg.t, value:msg.v, updateTime:room.tick})
})
messageHandlers.set(MessageType.PARTICIPANT_MOUSE, (msg, from, room) => {
  from.mousePos = str2Mouse(JSON.parse(msg.v)).position
  from.mouseMessageValue = msg.v
  from.mouseUpdateTime = room.tick
})

messageHandlers.set(MessageType.ROOM_PROP, (msg, _from, room) => {
  const [key, val] = JSON.parse(msg.v) as [string, string|undefined]
  if (val === undefined){
    room.properties.delete(key)
  }else{
    room.properties.set(key, val)
  }
  const remotes = Array.from(room.participants.values()).filter(remote => remote.id !== msg.p)
  remotes.forEach(remote => remote.messagesTo.push(msg))
})

messageHandlers.set(MessageType.REQUEST_ALL, (_msg, from, room) => {
  room.participants.forEach(remote => {
    remote.storedMessages.forEach(msg => from.pushOrUpdateMessage(msg))
  })
  room.properties.forEach((val, key) => {
    from.messagesTo.push({t:MessageType.ROOM_PROP, v:JSON.stringify([key, val])})
  })
  from.sendMessages()
})

function pushParticipantsInRangeOrMovedOut(from:ParticipantStore, room:RoomStore, visible:number[], audible:number[]){
  //  Push participants updated and in the range.
  const overlaps = room.participants.filter(p => p.id !== from.id && (p.onStage
    || (p.pose && (isInRect(p.pose.position, visible) || isInCircle(p.pose.position, audible)))
    )
  )
  for (const p of overlaps) { from.pushStatesToSend(p) }

  //  Push participants, who was in the range but moved out later.
  const overlapPSs = new Set(overlaps)
  const pidsOut:string[] =[] 
  from.participantsSent.forEach(sent => {
    if (!overlapPSs.has(sent.participant)) {
      if (isInRect(sent.position, visible) || isInCircle(sent.position, audible)){
        //  console.log(`Out call pushPositionToSend(${sent.participant.id})`)
        from.participantsSent.delete(sent.participant)
        pidsOut.push(sent.participant.id)
      }
    }
  })
  if (pidsOut.length) from.pushOrUpdateMessage({t:MessageType.PARTICIPANT_OUT, v:JSON.stringify(pidsOut)})
}

function pushMousesInRangeOrMovedOut(from:ParticipantStore, room:RoomStore, visible:number[], audible:number[]){
  //  Push participants updated and in the range.
  const overlaps = room.participants.filter(p => p.id !== from.id && 
    p.mousePos && (isInRect(p.mousePos, visible) || isInCircle(p.mousePos, audible)))
  for (const p of overlaps) { from.pushMouseToSend(p) }

  //  Push mouses, who was in the range but moved out later.
  const overlapPSs = new Set(overlaps)
  const pidsOut:string[] = []
  from.mousesSent.forEach(sent => {
    if (!overlapPSs.has(sent.participant)) {
      if (isInRect(sent.position, visible) || isInCircle(sent.position, audible)){
        from.mousesSent.delete(sent.participant)
        pidsOut.push(sent.participant.id)
      }
    }
  })
  if (pidsOut.length) from.pushOrUpdateMessage({t:MessageType.MOUSE_OUT, v:JSON.stringify(pidsOut)})
}


function pushContentsInRangeOrMovedOut(contents:Content[], from:ParticipantStore, visible:number[], audible:number[]){
  //  Find contents updated and in the range.
  const overlaps = contents.filter(c => {
    const rect = getRect(c.content.pose, c.content.size)
    return isOverlapped(rect, visible) || isOverlappedToCircle(rect, audible)
  })
  const contentsToSend = overlaps.filter(c => {
    const sent = from.contentsSent.get(c)
    if (sent){ return updateContentSent(sent) }
    from.contentsSent.set(c, createContentSent(c))
    return true
  }).map(c => c.content)

  //  Push contents, who was in the range but moved out later, to contentsToSend.
  const overlapIds = new Set(overlaps.map(c => c.content.id))
  const contentsRangeout:string[] = []
  from.contentsSent.forEach(sent => {
    if (!overlapIds.has(sent.content.content.id)) {
      const rect = getRect(sent.pose, sent.size)
      if (isOverlapped(rect, visible) || isOverlappedToCircle(rect, audible)){
        //  range out and remove from sent
        from.contentsSent.delete(sent.content)
        contentsRangeout.push(sent.content.content.id)
      }  
    }
  })

  if (contentsToSend.length){
    const msgToSend = {t:MessageType.CONTENT_UPDATE_REQUEST, v:JSON.stringify(contentsToSend)}
    from.pushOrUpdateMessage(msgToSend)
    //console.log(`CONTENT_UPDATE_REQUEST for ${contentsToSend.map(c=>c.id)} received from ${from.id}.`) 
  }
  if (contentsRangeout.length){
    const msgToSend = {t:MessageType.CONTENT_OUT, v:JSON.stringify(contentsRangeout)}
    from.pushOrUpdateMessage(msgToSend)
    //  console.log(`Contents ${contentsToSend.map(c=>c.id)} sent.`)  
  }
}

function pushContentsInfo(contents: Content[], from: ParticipantStore){
  //  Find contentsInfo updated.
  const contentsInfoToSend = contents.filter(c => {
    const sent = from.contentsInfoSent.get(c)
    if (sent){
      if (sent.timeSent < c.timeUpdateInfo){
        sent.timeSent = c.timeUpdateInfo
        return true
      }else{
        return false
      }
    }
    from.contentsInfoSent.set(c, {content:c.content, timeSent: c.timeUpdateInfo})
    return true
  }).map(c => extractSharedContentInfo(c.content))
  if (contentsInfoToSend.length){
    const msgToSend = {t:MessageType.CONTENT_INFO_UPDATE, v:JSON.stringify(contentsInfoToSend)}
    from.pushOrUpdateMessage(msgToSend)
    //  console.log(`Contents info ${contentsInfoToSend.map(c=>c.id)} sent.`)
  }
}

messageHandlers.set(MessageType.REQUEST_RANGE, (msg, from, room) => {
  room.tick ++;
  const ranges = JSON.parse(msg.v) as number[][]
  const visible = ranges[0]
  const audible = ranges[1]

  pushParticipantsInRangeOrMovedOut(from, room, visible, audible)
  pushMousesInRangeOrMovedOut(from, room, visible, audible)

  const contents = Array.from(room.contents.values())
  pushContentsInRangeOrMovedOut(contents, from, visible, audible)
  pushContentsInfo(contents, from)

  from.sendMessages()
})

messageHandlers.set(MessageType.REQUEST_PARTICIPANT_STATES, (msg, from, room)=> {
  room.tick ++;
  const pids = JSON.parse(msg.v) as string[]
  for (const pid of pids) {
    const p = room.participantsMap.get(pid)
    if (p){ from.pushStatesToSend(p) }
  }
  from.sendMessages()
})

messageHandlers.set(MessageType.CONTENT_UPDATE_REQUEST_BY_ID, (msg, from, room)=> {
  room.tick ++;
  const cids = JSON.parse(msg.v) as string[]
  const cs:ISharedContent[] = []
  for (const cid of cids) {
    const c = room.contents.get(cid)
    if (c) {
      cs.push(c.content)
      const sent = from.contentsSent.get(c)
      if (sent){
        updateContentSent(sent)
      }else{
        from.contentsSent.set(c, createContentSent(c))
      }
    }
  }
  msg.v = JSON.stringify(cs)
  msg.t = MessageType.CONTENT_UPDATE_REQUEST
  from.pushOrUpdateMessage(msg)
})

messageHandlers.set(MessageType.REQUEST_TO, (msg, from, room) => {
  room.tick ++;
  const pids = JSON.parse(msg.v) as string[]
  //console.log(`REQUEST_TO ${pids}`)
  msg.v = ''
  delete msg.p
  for(const pid of pids){
    const to = room.participantsMap.get(pid)
    if (to){
      if (to.storedMessages.has(MessageType.PARTICIPANT_INFO)){
        to.storedMessages.forEach(stored => from.pushOrUpdateMessage(stored))
        from.pushStatesToSend(to)
        //console.log(`Info for ${to.id} found and sent to ${from.id}.`)
      }else{
        const len = to.messagesTo.length
        to.pushOrUpdateMessage(msg)
        if (len != to.messagesTo.length){
          //console.log(`Info for ${to.id} not found and a request has sent.`)
        }
      }
    }
  }
})

messageHandlers.set(MessageType.PARTICIPANT_LEFT, (msg, from, room) => {
  //  console.log(`${JSON.stringify(msg)}`)
  let pids = JSON.parse(msg.v) as string[]
  if (!msg.v || pids === []){ pids = [from.id] }
  for(const pid of pids){
    const participant = room.participantsMap.get(pid)
    if (participant && !participant.socket.isClosed){
      participant.socket.close(1000, 'closed by PARTICIPANT_LEFT message.').catch(reason => {
        console.error(`participant.socket.close(1000) failed by reason=${reason}`)
      })
      room.onParticipantLeft(participant)

      //console.log(`states: ${JSON.stringify(Array.from(participant.participantStates.values()))}`)
      const infoMsg = participant.storedMessages.get(MessageType.PARTICIPANT_INFO)
      const name = infoMsg ? JSON.parse(infoMsg.v).name : ''
      console.log(`Participant ${pid}:"${name}" left. ${room.participants.length} remain in "${room.id}".`)
    }else{
      //  console.error(`PARTICIPANT_LEFT can not find pid=${pid}`)
    }  
  }
  for(const participant of room.participants){
    const msgToSend = {t:MessageType.PARTICIPANT_LEFT, v:JSON.stringify(pids)}
    participant.pushOrUpdateMessage(msgToSend)
  }
})

messageHandlers.set(MessageType.CONTENT_UPDATE_REQUEST, (msg, from, room) => {
  const cs = JSON.parse(msg.v) as ISharedContent[]
  const time = room.tick
  for(const newContent of cs){
    //  upate room's content
    let c = room.contents.get(newContent.id)
    if (c){
      c.timeUpdate = time
      if (!isEqualSharedContentInfo(c.content, newContent)) { c.timeUpdateInfo = time }
      c.content = newContent
    }else{
      c = {content:newContent, timeUpdate: time, timeUpdateInfo: time}
      room.contents.set(c.content.id, c)
    }
    //  The sender should not receive the update. 
    from.contentsSent.set(c, createContentSent(c))
    from.contentsInfoSent.set(c, {content:c.content, timeSent: c.timeUpdateInfo})
  }
  //  console.log(`Contents update ${cs.map(c=>c.id)} at ${time}`)
})

messageHandlers.set(MessageType.CONTENT_REMOVE_REQUEST, (msg, from, room) => {
  const cids = JSON.parse(msg.v) as string[]
  room.removeContents(cids, from)
})

const CONNECTION_CHECK_INTERVAL = 30 * 1000   //  Check lastRecieveTime every 30 seconds.
const CONNECTION_TIMEOUT = 3 * 60 * 1000      //  Timeout in 3 minutes.

setInterval(()=>{
  const now = Date.now()
  for(const room of rooms.rooms.values()){
    const timeouts = room.participants.filter(p => p.lastReceiveTime + CONNECTION_TIMEOUT < now)
    for(const p of timeouts){
      const msg = p.storedMessages.get(MessageType.PARTICIPANT_INFO)
      const name = msg ? JSON.parse(msg.v)?.name : undefined
      console.log(`Participant ${p.id}:${name ? `"${name}"` : 'undefined'} left by connection lost detected by server. ${room.participants.length} remain in "${room.id}".`)
      p.socket.close(1002, `Closed by server. No packet during ${CONNECTION_TIMEOUT/1000} sec.`).catch(reason => {
        console.error(`Failed to close socket by timeout for ${p.id} reason:${reason}.`)
      })
      room.onParticipantLeft(p)
    }
  }
}, CONNECTION_CHECK_INTERVAL)

type AuthType = 'google'|'anonymous'|'basic'


async function handleWs(sock: WebSocket, authParams:{auth: string, authType:AuthType, pass?:string}) {
  try {
    for await (const ev of sock) {
      if (typeof ev === "string") {
        // text message.
        const msgs = JSON.parse(ev) as Message[]
        for(const msg of msgs){
          //  if (msg.t !== MessageType.REQUEST_RANGE && msg.t !== MessageType.PARTICIPANT_MOUSE){ console.log('ws:', ev); }
          if (!msg.t){
            console.error(`Invalid message: ${ev}`)
          }

          if (msg.r && msg.p){
            //  create room and participant
            let isAuth = false         
            if(authParams.authType!='anonymous')
              isAuth = await validateAuth(authParams.auth,authParams.authType)

            //TODO: if we want anonymous users to authenticate only with password, register the option
            room = rooms.get(msg.r,!!msg.rp, msg.rp)  
            console.log({room}) 

            if(room.isPrivate && !isAuth && room.password !== msg.rp) throw new Error("Invalid password");

            participant = room.getParticipant(msg.p, sock)
            rooms.sockMap.set(sock, {room, participant})
            console.log(`Participant ${participant.id} joined. ${room.participants.length} people in "${room.id}".`)
          }else{
            const rp = rooms.sockMap.get(sock)!
            room = rp.room
            participant = rp.participant
          }

          participant.lastReceiveTime = Date.now()

          //  call handler
          const handler = messageHandlers.get(msg.t)
          if (handler){
            handler(msg, participant, room)
          }else{
            console.error(`No message handler for ${msg.t} - ${ev}`)
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
              room.onParticipantLeft(participant)
              return
            }
          }
        }
        if (code!==0 || reason !== 'left'){
          //console.log(`websocket close. code:${code}, reason:${reason}`)
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


//TODO: replace keys with secrets
const ga = new GoogleOAuth2({
  client_id: "858773398697-vki2lito392c5dlss9s31ap077nn0qbd.apps.googleusercontent.com",
  client_secret: "AIzaSyAADCXxUujmh0VqXIzJofwl03MA5O8v8EQ",
  redirect_uri: "http://example.com/redirect_uri",
  "scopes": [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
});

async function validateAuth(auth: string, authType:AuthType){
  try {
    if(authType === 'google'){
      const data = ga.decodeIdToken(auth);
      return !!data
    }
    //TODO: only testing, remove
    else if (authType ==='basic') return true
    else{
      console.log("The only auth strategy implemented is google, please implement more if required");
      return false
    }
  } catch (error) {
    return false
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

    let authKey: string | undefined;
    if(!req.url.match(/auth/)){
      authKey = (req.headers.get('authorization') || '').split(' ')[1]
    }

    const { conn, r: bufReader, w: bufWriter, headers, url } = req;
    const params = new URLSearchParams(url.replace('/',''))

    if(authKey){
      const user = ga.decodeIdToken(authKey)
      console.log(user)
      params.append('authData', JSON.stringify(user))
    }

    const pass = params.get('roomPassword') || undefined
    const auth = params.get('authData') || ''
    const authType = params.get('authorizationType') as AuthType || 'anonymous'
    acceptWebSocket({
      conn,
      bufReader,
      bufWriter,
      headers,
    })
      .then((s)=>handleWs(s,{auth,authType, pass}))
      .catch(async (err) => {
        console.error(`failed to accept websocket: ${err}`);
        await req.respond({ status: 400 });
      });
  }
}
