import {serve} from "https://deno.land/std/http/server.ts"
import {serveTLS} from "https://deno.land/std/http/server.ts"
import {acceptWebSocket, isWebSocketCloseEvent, isWebSocketPingEvent, WebSocket} from "https://deno.land/std/ws/mod.ts"

import {BMMessage as Message} from './BMMessage.ts'
import {extractSharedContentInfo, ISharedContent, isEqualSharedContentInfo} from './ISharedContent.ts'
import {MessageType, InstantMessageType, StoredMessageType, InstantMessageKeys, StoredMessageKeys, 
  ParticipantMessageType, ParticipantMessageKeys} from './MessageType.ts'
import {getRect, isOverlapped, isOverlappedToCircle, isInRect, isInCircle, str2Mouse, str2Pose} from './coordinates.ts'

import {messageHandlers, rooms, RoomStore, ParticipantStore} from './Stores.ts'

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
function participantMessageHandler(msg: Message, from: ParticipantStore){
  from.participantStates.set(msg.t, {type:msg.t, updateTime: Date.now(), value:msg.v})
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

messageHandlers.set(MessageType.PARTICIPANT_POSE, (msg, from) => {
  //  console.log(`str2Pose(${msg.v}) = ${JSON.stringify(str2Pose(JSON.parse(msg.v)))}`)
  from.pose = str2Pose(JSON.parse(msg.v))
  from.participantStates.set(msg.t, {type:msg.t, value:msg.v, updateTime:Date.now()})
})
messageHandlers.set(MessageType.PARTICIPANT_ON_STAGE, (msg, from) => {
  from.onStage = JSON.parse(msg.v)
  from.participantStates.set(msg.t, {type:msg.t, value:msg.v, updateTime:Date.now()})
})
messageHandlers.set(MessageType.PARTICIPANT_MOUSE, (msg, from) => {
  from.mousePos = str2Mouse(JSON.parse(msg.v)).position
  from.mouseMessageValue = msg.v
  from.mouseUpdateTime = Date.now()
})
messageHandlers.set(MessageType.REQUEST_ALL, (_msg, from, room) => {
  room.participants.forEach(remote => {
    remote.storedMessages.forEach(msg => from.pushOrUpdateMessage(msg))
  })
})

messageHandlers.set(MessageType.REQUEST_RANGE, (msg, from, room) => {
  const ranges = JSON.parse(msg.v) as number[][]
  const visible = ranges[0]
  const audible = ranges[1]

    //  Find participant states updated and in the range
    {
    const overlaps = room.participants.filter(p => p.onStage 
      || (p.pose && (isInRect(p.pose.position, visible) || isInCircle(p.pose.position, audible))))
    const lastAndNow = [... new Set(overlaps.concat(from.overlappedParticipants))]
    if (lastAndNow.length !== overlaps.length){
      console.log(`RANGE participant overlap:${overlaps.map(p=>p.id)} lastAndNow:${lastAndNow.map(p=>p.id)}`)
    }
    from.overlappedParticipants = overlaps
    for (const p of lastAndNow) { from.pushStatesOf(p) }
  }
  //  Check mouse is in the range and updated
  {
    const overlaps = room.participants.filter(p => p.mousePos && isInRect(p.mousePos, visible))
    const lastAndNow = [... new Set(overlaps.concat(from.overlappedMouses))]
    if (lastAndNow.length !== overlaps.length){
      console.log(`RANGE participant overlap:${overlaps.map(p=>p.id)} lastAndNow:${lastAndNow.map(p=>p.id)}`)
    }
    from.overlappedMouses = overlaps
    for (const p of lastAndNow) {
      const sentTime = from.timeSentMouse.get(p.id)
      if (p.mouseMessageValue && (!sentTime || p.mouseUpdateTime > sentTime)){
        from.pushOrUpdateMessage({t:MessageType.PARTICIPANT_MOUSE, v:p.mouseMessageValue, p:p.id})
      }
      from.timeSentMouse.set(p.id, p.mouseUpdateTime)
    }
  }

  //  Find contents updated and in the range.
  const contents = Array.from(room.contents.values())
  const overlaps = contents.filter(c => {
    const rect = getRect(c.content.pose, c.content.size)
    return isOverlapped(rect, visible) || isOverlappedToCircle(rect, audible)
  })
  const lastAndNow = [... new Set(overlaps.concat(from.overlappedContents))]
  if (lastAndNow.length !== overlaps.length){
    console.log(`RANGE overlap:${overlaps.map(c=>c.content.id)} lastAndNow:${lastAndNow.map(c=>c.content.id)}`)
  }
  from.overlappedContents = overlaps
  const contentsToSend = lastAndNow.filter(c => {
    const sent = from.contentsSent.get(c.content.id)
    if (sent){
      if (sent.timeSent < c.timeUpdate){
        sent.timeSent = c.timeUpdate
        return true
      }else{
        return false
      }
    }
    from.contentsSent.set(c.content.id, {content:c.content, timeSent: c.timeUpdate})
    return true
  }).map(c => c.content)
  //if (overlaps.length){ console.log(`REQUEST_RANGE overlap:${overlaps.length} send:${contentsToSend.length}`) }
  if (contentsToSend.length){
    const msgToSend = {r:room.id, t:MessageType.CONTENT_UPDATE_REQUEST, p:'', d:'', v:JSON.stringify(contentsToSend)}
    from.pushOrUpdateMessage(msgToSend)  
    //  console.log(`Contents ${contentsToSend.map(c=>c.id)} sent.`)  
  }

  //  Find contentsInfo updated.
  const contentsInfoToSend = contents.filter(c => {
    const sent = from.contentsInfoSent.get(c.content.id)
    if (sent){
      if (sent.timeSent < c.timeUpdateInfo){
        sent.timeSent = c.timeUpdateInfo
        return true
      }else{
        return false
      }
    }
    from.contentsInfoSent.set(c.content.id, {content:c.content, timeSent: c.timeUpdateInfo})
    return true
  }).map(c => extractSharedContentInfo(c.content))
  if (contentsInfoToSend.length){
    const msgToSend = {r:room.id, t:MessageType.CONTENT_INFO_UPDATE, p:'', d:'', v:JSON.stringify(contentsInfoToSend)}
    from.pushOrUpdateMessage(msgToSend)
    //  console.log(`Contents info ${contentsInfoToSend.map(c=>c.id)} sent.`)
  }

  from.sendMessages()
})

messageHandlers.set(MessageType.REQUEST_PARTICIPANT_STATES, (msg, from, room)=> {
  const pids = JSON.parse(msg.v) as string[]
  for (const pid of pids) {
    const p = room.participantsMap.get(pid)
    if (p){ from.pushStatesOf(p) }
  }
  from.sendMessages()
})

messageHandlers.set(MessageType.CONTENT_UPDATE_REQUEST_BY_ID, (msg, from, room)=> {
  const cids = JSON.parse(msg.v) as string[]
  const cs:ISharedContent[] = []
  for (const cid of cids) {
    const c = room.contents.get(cid)
    if (c) {
      cs.push(c.content)
      from.contentsSent.set(c.content.id, {content:c.content, timeSent: c.timeUpdate})
    }
  }
  msg.v = JSON.stringify(cs)
  msg.t = MessageType.CONTENT_UPDATE_REQUEST
  from.pushOrUpdateMessage(msg)
})

messageHandlers.set(MessageType.REQUEST_TO, (msg, from, room) => {
  const pids = JSON.parse(msg.v) as string[]
  //console.log(`REQUEST_TO ${pids}`)
  msg.v = ''
  delete msg.p
  for(const pid of pids){
    const to = room.participantsMap.get(pid)
    if (to){
      if (to.storedMessages.has(MessageType.PARTICIPANT_INFO)){
        to.storedMessages.forEach(stored => from.pushOrUpdateMessage(stored))
        from.pushStatesOf(to)
        console.log(`Info for ${to.id} found and sent to ${from.id}.`)
      }else{
        const len = to.messagesTo.length
        to.pushOrUpdateMessage(msg)
        if (len != to.messagesTo.length){
          console.log(`Info for ${to.id} not found and a request has sent.`)
        }
      }
    }
  }
})

messageHandlers.set(MessageType.PARTICIPANT_LEFT, (msg, from, room) => {
  const pid = JSON.parse(msg.v) as string
  const participant = pid ? room.participantsMap.get(pid) : from
  if (participant){
    participant.socket.close(1000, 'closed by PARTICIPANT_LEFT message.')
    room.onParticipantLeft(participant)
    console.log(`participant ${msg.p} left. ${room.participants.length} remain.`)
  }else{
    //  console.error(`PARTICIPANT_LEFT can not find pid=${msg.p}`)
  }
})

messageHandlers.set(MessageType.CONTENT_UPDATE_REQUEST, (msg, participant, room) => {
  const cs = JSON.parse(msg.v) as ISharedContent[]
  const time = Date.now()
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
    participant.contentsSent.set(c.content.id, {content:c.content, timeSent: c.timeUpdate})
    participant.contentsInfoSent.set(c.content.id, {content:c.content, timeSent: c.timeUpdateInfo})
  }
  //  console.log(`Contents update ${cs.map(c=>c.id)} at ${time}`)
})

messageHandlers.set(MessageType.CONTENT_REMOVE_REQUEST, (msg, _participant, room) => {
  const cids = JSON.parse(msg.v) as string[]
  //   delete contents
  for(const cid of cids){
    room.contents.delete(cid)
  }
  //  forward remove request to all remote participants
  const remotes = Array.from(room.participants.values()).filter(participant => participant.id !== msg.p)
  remotes.forEach(remote => {
    for(const cid of cids){
      remote.contentsSent.delete(cid)
      remote.contentsInfoSent.delete(cid)
      const idx = remote.overlappedContents.findIndex(c => c.content.id === cid)
      if (idx >= 0){ remote.overlappedContents.splice(idx, 1) }
    }
    remote.pushOrUpdateMessage(msg)    
  })
})

async function handleWs(sock: WebSocket) {
  try {
    for await (const ev of sock) {
      if (typeof ev === "string") {
        // text message.
        const msg = JSON.parse(ev) as Message
        //  if (msg.t !== MessageType.REQUEST_RANGE && msg.t !== MessageType.PARTICIPANT_MOUSE){ console.log('ws:', ev); }
        if (!msg.t){
          console.error(`Invalid message: ${ev}`)
        }

        //  prepare participant and room
        let participant:ParticipantStore
        let room:RoomStore
        if (msg.r && msg.p){
          //  create room and participant
          room = rooms.get(msg.r)
          participant = room.getParticipant(msg.p, sock)
          rooms.sockMap.set(sock, {room, participant})
        }else{
          const rp = rooms.sockMap.get(sock)!
          room = rp.room
          participant = rp.participant
        }

        //  call handler
        const handler = messageHandlers.get(msg.t)
        if (handler){
          handler(msg, participant, room)
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
