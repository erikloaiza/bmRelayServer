import {ISharedContent, SharedContentInfo, isContentWallpaper} from './ISharedContent.ts'
import {Pose2DMap} from './coordinates.ts'
import {BMMessage as Message} from './BMMessage.ts'
import {WebSocket} from "https://deno.land/std/ws/mod.ts"

export interface ParticipantSent{
  participant: ParticipantStore,
  timestamp: number 
}
export interface Content{
  content: ISharedContent,
  timeUpdate: number,
  timeUpdateInfo: number 
}
export interface ContentSent{
  content: ISharedContent,
  timeSent: number 
}
export interface ContentInfoSent{
  content: SharedContentInfo,
  timeSent: number 
}
export interface ParticipantState{
  type: string
  updateTime: number
  value: string
}
export class ParticipantStore {
  id: string
  socket:WebSocket
  //  participant related
  pose?: Pose2DMap
  storedMessages = new Map<string, Message>()   //  key=type
  participantStates = new Map<string, ParticipantState>() //  key=type
  timeSentStates = new Map<string, number>()  //  key=pid, value=timestamp
  messagesTo:Message[] = []                   //
  participantsSent:Map<string, ParticipantSent> = new Map()
  overlappedParticipants:ParticipantStore[] = []

  //  mouse related
  mousePos?: [number,number]
  mouseUpdateTime = 0
  overlappedMouses: ParticipantStore[] = []
  timeSentMouse = new Map<string, number>()  //  key=pid, value=timestamp
  mouseMessageValue?: string

  //  contents related
  contentsSent:Map<string, ContentSent> = new Map()
  contentsInfoSent:Map<string, ContentInfoSent> = new Map()
  overlappedContents:Content[] = []

  //  add message to send
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
  //  Push states of a participant to send to this participant.
  pushStatesOf(p: ParticipantStore){
    const sentTime = this.timeSentStates.get(p.id)
    let latest = sentTime ? sentTime : 0
    p.participantStates.forEach((s, mt) => {
      if (!sentTime || s.updateTime > sentTime){
        this.pushOrUpdateMessage({t:mt, v:s.value, p:p.id})
        latest = Math.max(latest, s.updateTime)
      }
    })
    this.timeSentStates.set(p.id, latest)
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
        if (!isContentWallpaper(c.content)){ this.contents.delete(c.content.id) }
      })
    }
    for(const remain of this.participants){
      const idx = remain.overlappedParticipants.findIndex(p => p === participant)
      if (idx >= 0){ remain.overlappedParticipants.splice(idx, 1) }
      const idx2 = remain.overlappedMouses.findIndex(p => p === participant)
      if (idx2 >= 0){ remain.overlappedMouses.splice(idx2, 1) }
    }
  }

  //  room properties
  properties = new Map<string, string>()
  
  //  room contents
  contents = new Map<string, Content>()
}

export interface PandR{
  participant: ParticipantStore
  room: RoomStore
}
export class Rooms{
  rooms = new Map<string, RoomStore>()
  sockMap = new Map<WebSocket, PandR>()
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
export const rooms = new Rooms();
(window as any).rooms = rooms

type MessageHandler = (msg: Message, participant: ParticipantStore, room: RoomStore) => void
export const messageHandlers = new Map<string, MessageHandler>()
