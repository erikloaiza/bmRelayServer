import {serve} from "https://deno.land/std/http/server.ts"
import {serveTLS} from "https://deno.land/std/http/server.ts"
import {acceptWebSocket, isWebSocketCloseEvent, isWebSocketPingEvent, WebSocket} from "https://deno.land/std/ws/mod.ts"

import {BMMessage as Message} from './BMMessage.ts'
import {extractSharedContentInfo, ISharedContent, isEqualSharedContentInfo} from './ISharedContent.ts'
import {MessageType, InstantMessageType, StoredMessageType, InstantMessageKeys, StoredMessageKeys, 
  ParticipantMessageType, ParticipantMessageKeys} from './MessageType.ts'
import {getRect, isOverlapped, isOverlappedToCircle, isInRect, isInCircle, str2Mouse, str2Pose} from './coordinates.ts'

import {Content, messageHandlers, rooms, RoomStore, ParticipantStore, createContentSent, updateContentSent} from './Stores.ts'

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
  //  set pose
  from.pose = str2Pose(JSON.parse(msg.v))
  //  also set the message as one of the state of the participant.
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
  const overlaps = room.participants.filter(p => p.onStage 
    || (p.pose && (isInRect(p.pose.position, visible) || isInCircle(p.pose.position, audible))))
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
  from.pushOrUpdateMessage({t:MessageType.PARTICIPANT_OUT, v:JSON.stringify(pidsOut)})
}

function pushMousesInRangeOrMovedOut(from:ParticipantStore, room:RoomStore, visible:number[], audible:number[]){
  //  Push participants updated and in the range.
  const overlaps = room.participants.filter(p => 
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
  from.pushOrUpdateMessage({t:MessageType.MOUSE_OUT, v:JSON.stringify(pidsOut)})
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
    //  console.log(`Contents ${contentsToSend.map(c=>c.id)} sent.`)  
  }
  if (contentsRangeout.length){
    const msgToSend = {t:MessageType.CONTENT_OUT, v:JSON.stringify(contentsRangeout)}
    from.pushOrUpdateMessage(msgToSend)
    //  console.log(`Contents ${contentsToSend.map(c=>c.id)} sent.`)  
  }
}

messageHandlers.set(MessageType.REQUEST_RANGE, (msg, from, room) => {
  const ranges = JSON.parse(msg.v) as number[][]
  const visible = ranges[0]
  const audible = ranges[1]

  pushParticipantsInRangeOrMovedOut(from, room, visible, audible)
  pushMousesInRangeOrMovedOut(from, room, visible, audible)
  const contents = Array.from(room.contents.values())
  pushContentsInRangeOrMovedOut(contents, from, visible, audible)

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

  from.sendMessages()
})

messageHandlers.set(MessageType.REQUEST_PARTICIPANT_STATES, (msg, from, room)=> {
  const pids = JSON.parse(msg.v) as string[]
  for (const pid of pids) {
    const p = room.participantsMap.get(pid)
    if (p){ from.pushStatesToSend(p) }
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
  let pids = JSON.parse(msg.v) as string[]
  if (!msg.v || pids === []){ pids = [from.id] }
  for(const pid of pids){
    const participant = room.participantsMap.get(pid)
    if (participant && !participant.socket.isClosed){
      participant.socket.close(1000, 'closed by PARTICIPANT_LEFT message.')
      room.onParticipantLeft(participant)
      //console.log(`participant ${msg.p} left. ${room.participants.length} remain.`)
    }else{
      //  console.error(`PARTICIPANT_LEFT can not find pid=${msg.p}`)
    }  
  }
})

messageHandlers.set(MessageType.CONTENT_UPDATE_REQUEST, (msg, from, room) => {
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
    from.contentsSent.set(c, createContentSent(c))
    from.contentsInfoSent.set(c, {content:c.content, timeSent: c.timeUpdateInfo})
  }
  //  console.log(`Contents update ${cs.map(c=>c.id)} at ${time}`)
})

messageHandlers.set(MessageType.CONTENT_REMOVE_REQUEST, (msg, _participant, room) => {
  const cids = JSON.parse(msg.v) as string[]
  //   delete contents
  const contents:Content[] = []
  for(const cid of cids){
    const c = room.contents.get(cid)
    if (c){
      contents.push(c)
      room.contents.delete(cid)
    }
  }
  //  forward remove request to all remote participants
  const remotes = Array.from(room.participants.values()).filter(participant => participant.id !== msg.p)
  remotes.forEach(remote => {
    for(const c of contents){
      remote.contentsSent.delete(c)
      remote.contentsInfoSent.delete(c)
    }
    remote.pushOrUpdateMessage(msg)    
  })
})

async function handleWs(sock: WebSocket) {
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
