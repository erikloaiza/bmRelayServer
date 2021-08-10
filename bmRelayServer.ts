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
  interval:number|undefined = undefined
  period = 100
  setPeriod(period: number){
    if (this.interval){
      try{
        clearInterval(this.interval)
        this.interval = undefined
      }
      catch{
        console.error(`Failed to clear interval ${this.interval} of pid ${this.id}.`)
        this.interval = undefined
      } 
    }
    this.interval = setInterval(()=>{
      if (this.messagesTo.length){
        try{
          this.socket.send(JSON.stringify(this.messagesTo))
        }
        catch(e){
          console.error(e)
        }
        this.messagesTo = []
        //console.log(`${this.messagesTo.length} msg sent to ${this.id} v:${JSON.stringify(this.messagesTo)}`)
      }      
    }, period)
    console.log(`Set send period of ${period} for pid:${this.id}`)
    this.period = period
  }
  pushOrUpdateMessage(msg: Message){
    const found = this.messagesTo.findIndex(m => m.t === msg.t && m.p === msg.p)
    if (found >= 0){
      this.messagesTo[found] = msg  //  update
    }else{
      this.messagesTo.push(msg)     //  push
    }
  }
  
  constructor(id:string, socket:WebSocket){
    this.id = id
    this.socket = socket
    this.setPeriod(this.period)
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
          participant.messagesTo = participant.messagesTo.concat(...msgArrays)
        }else if (msg.t === MessageTypeSpecial.SET_PERIOD){
          const period = JSON.parse(msg.v)
          if (period > 0){
            participant.setPeriod(period)
          }
        }else if (msg.t === MessageTypeSpecial.PARTICIPANT_LEFT){
          room.participants.delete(participant.id)
          console.log(`Participant ${participant.id} left by message: ${ev}`);
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
        console.log(`websocket close. code:${code}, reason:${reason}`)
      }
    }
  } catch (err) {
    console.error(`Failed to receive frame: ${err}`);
    if (!sock.isClosed) {
      await sock.close(1000).catch(console.error);  //  code 1000 : Normal Closure
    }
  }
}

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
