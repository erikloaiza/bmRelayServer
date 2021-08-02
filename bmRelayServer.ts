// Copyright 2018-2021 the Deno authors. All rights reserved. MIT license.
import { serve } from "https://deno.land/std/http/server.ts"
import { serveTLS } from "https://deno.land/std/http/server.ts"
import {
  acceptWebSocket,
  isWebSocketCloseEvent,
  isWebSocketPingEvent,
  WebSocket,
} from "https://deno.land/std/ws/mod.ts"
import {Message, messageTypeStoreSet, MessageTypeSpecial} from './Message.ts'

export class ParticipantStore {
  id: string
  socket:WebSocket
  storedMessages = new Map<string, Message>()   //  key=type
  messagesTo:Message[] = []                   //
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
const rooms = new Rooms()
interface Socket{
  rid: string
  pid: string
}
const sockets:Map<WebSocket, Socket> = new Map()

async function handleWs(sock: WebSocket) {
  try {
    for await (const ev of sock) {
      if (typeof ev === "string") {
        // text message.
        console.log("ws:", ev);
        const msg = JSON.parse(ev) as Message
        if (!msg.p || !msg.r || !msg.t){
          console.error(`Invalid message: ${ev}`)
        }
        const room = rooms.get(msg.r)
        const participant = room.getParticipant(msg.p, sock)
        sockets.set(sock, {rid: msg.r, pid: msg.p})
        if (msg.t === MessageTypeSpecial.REQUEST){
          const msgArrays = Array.from(room.participants.values()).filter(remote => remote.id !== participant.id)
            .map(remote => Array.from(remote.storedMessages.values()))
          participant.messagesTo = participant.messagesTo.concat(...msgArrays)
        }else if (msg.t === MessageTypeSpecial.PARTICIPANT_LEFT){
          room.participants.delete(participant.id)
          sockets.delete(participant.socket)
          console.log("Participant ${s.pid} left by message", ev);
        }else{ 
          if (messageTypeStoreSet.has(msg.t)){  //  store message if needed
            participant.storedMessages.set(msg.t, msg)
          }
          //  send message to destination or all remotes
          if (msg.d){
            const to = room.participants.get(msg.d)
            if (to){
              to.messagesTo.push(msg)
            }
          }else{
            const remotes = Array.from(room.participants.values()).filter(remote => remote.id !== participant.id)
            remotes.forEach(remote => remote.messagesTo.push(msg))
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
        // close.
        const s = sockets.get(sock)
        if (s){
          console.log("Participant ${s.pid} left by websocket close", ev);
          rooms.rooms.get(s.rid)?.participants.delete(s.pid)
          sockets.delete(sock)
        }else{
          console.error('Sock to close not found.')
        }
        const { code, reason } = ev;
      }
    }
  } catch (err) {
    console.error(`failed to receive frame: ${err}`);

    if (!sock.isClosed) {
      await sock.close(1000).catch(console.error);
    }
  }
}
setInterval(()=>{
  rooms.rooms.forEach(room => {
    room.participants.forEach(participant => {
      if (participant.messagesTo.length){
        participant.socket.send(JSON.stringify(participant.messagesTo))
        console.log(`${participant.messagesTo.length} msg sent to ${participant.id} v:${JSON.stringify(participant.messagesTo)}`)
        participant.messagesTo = []
      }
    })
  })
}, 100)

if (import.meta.main) {
  /** websocket message relay server */
  const port = Deno.args[0] || "8443";
  const TLS = Deno.args[1] || false;
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
