import {ISharedContent, SharedContentInfo, isContentWallpaper} from './ISharedContent.ts'
import {Pose2DMap, clonePose2DMap, cloneV2} from './coordinates.ts'
import {BMMessage as Message, ObjectArrayMessage} from './BMMessage.ts'
import {MessageType} from './MessageType.ts'
import {WebSocket} from "https://deno.land/std/ws/mod.ts"
import {ObjectArrayMessageTypes, StringArrayMessageTypes} from './MessageType.ts'

export interface Content{
  content: ISharedContent,
  timeUpdate: number,
  timeUpdateInfo: number 
}
export interface ParticipantSent{
  participant: ParticipantStore,
  timeSent: number 
  position: [number, number]
}
function createParticipantSent(p: ParticipantStore, timeSent: number): ParticipantSent|undefined{
  if (!p.pose){
    console.error(`Participant ${p.id} does not have pose.`)
    return
  }else{
    return {
      participant: p,
      timeSent,
      position: cloneV2(p.pose.position)
    }  
  }
}
function updateParticipantSent(sent: ParticipantSent, updateTime: number){
  if (sent.participant.pose){
    sent.position = cloneV2(sent.participant.pose.position)
    sent.timeSent = updateTime 
  }else{
    console.error(`No pose for ${sent.participant.id} in updateParticipantSent().`)
  }
}

export interface ContentSent{
  content: Content,
  timeSent: number
  pose: Pose2DMap
  size: [number, number] 
}
export function updateContentSent(sent: ContentSent){
  if (sent.timeSent < sent.content.timeUpdate){
    sent.timeSent = sent.content.timeUpdate
    sent.pose = clonePose2DMap(sent.content.content.pose)
    sent.size = cloneV2(sent.content.content.size)
    return true
  }else{
    return false
  }
}
export function createContentSent(c: Content):ContentSent{
  return {content:c, timeSent:c.timeUpdate, 
    pose:clonePose2DMap(c.content.pose), size:cloneV2(c.content.size)}
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
  onStage = false
  storedMessages = new Map<string, Message>()   //  key=type
  participantStates = new Map<string, ParticipantState>() //  key=type
  timeSentStates = new Map<string, number>()
  messagesTo:Message[] = []                     //

  //  participant related
  pose?: Pose2DMap
  participantsSent:Map<ParticipantStore, ParticipantSent> = new Map()

  //  mouse related
  mouseMessageValue?: string
  mousePos?: [number,number]
  mouseUpdateTime = 0
  mousesSent:Map<ParticipantStore, ParticipantSent> = new Map()

  //  contents related
  contentsSent:Map<Content, ContentSent> = new Map()
  contentsInfoSent:Map<Content, ContentInfoSent> = new Map()

  //  add message to send
  pushOrUpdateMessage(msg: Message){
    const found = this.messagesTo.findIndex(m => m.t === msg.t && m.p === msg.p)
    if (found >= 0){
      //  same message type is already in the queue (messagesTo).
      if (ObjectArrayMessageTypes.has(msg.t)){
        //  Merge new messages to existing one.
        const values = JSON.parse(this.messagesTo[found].v) as ObjectArrayMessage[]
        const toAdds = JSON.parse(msg.v) as ObjectArrayMessage[]
        for (const toAdd of toAdds){
          const idx = values.findIndex(v => v.id === toAdd.id)
          if (idx >= 0){
            values[idx] = toAdd
          }else{
            values.push(toAdd)
          }         
        }
      }else if(StringArrayMessageTypes.has(msg.t)){
        //  Merge new messages to existing one.
        const values = JSON.parse(this.messagesTo[found].v) as string[]
        const toAdds = JSON.parse(msg.v) as string[]
        for (const toAdd of toAdds){
          const idx = values.findIndex(v => v === toAdd)
          if (idx >= 0){
            values[idx] = toAdd
          }else{
            values.push(toAdd)
          }
        }
      }else{
        //  Replace existing message by new one.
        this.messagesTo[found] = msg  //  update
      }
    }else{
      //  add new message.
      this.messagesTo.push(msg)     //  push
    } 
  }
  
  sendMessages(){ //  Client wait response of the server. Server must always send packet.
    try{
      if (!this.socket.isClosed){
        this.socket.send(JSON.stringify(this.messagesTo))
      }
    }
    catch(e){
      console.error(e)
    }
    this.messagesTo = []
  }
  //  Push states of a participant to send to this participant.
  pushStatesToSend(p: ParticipantStore){
    const sent = this.participantsSent.get(p)
    const sentTime = sent?.timeSent
    let latest = sentTime ? sentTime : 0
    p.participantStates.forEach((s, mt) => {
      if (!sentTime || s.updateTime > sentTime){
        this.pushOrUpdateMessage({t:mt, v:s.value, p:p.id})
        latest = Math.max(latest, s.updateTime)
      }
    })
    if (sent) {
      updateParticipantSent(sent, latest)
    }else{
      const newSent = createParticipantSent(p, latest)
      if (newSent){ this.participantsSent.set(p, newSent) }
    }
  }
  pushMouseToSend(p:ParticipantStore, sent?:ParticipantSent){
    if (p.mousePos && p.mouseMessageValue){
      if (!sent){ sent = this.mousesSent.get(p) }
      if (sent){
        sent.timeSent = p.mouseUpdateTime
        sent.position = cloneV2(p.mousePos)
      }else{
        sent = {timeSent:p.mouseUpdateTime, position:cloneV2(p.mousePos),  participant:p}
        this.mousesSent.set(p, sent)
      }
      this.pushOrUpdateMessage({t:MessageType.PARTICIPANT_MOUSE, v:p.mouseMessageValue, p:sent.participant.id})
    }
  }

  constructor(id:string, socket:WebSocket){
    this.id = id
    this.socket = socket
  }
}
  
export class RoomStore {
  id: string                                //  room id
  tick = 1
  participantsMap = new Map<string, ParticipantStore>()  //  key=source pid
  participants:ParticipantStore[] = []
  properties = new Map<string, string>()    //  room properties  
  contents = new Map<string, Content>()     //  room contents


  constructor(roomId: string){
    this.id = roomId
    console.log(`Room ${this.id} created.`)
  }

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
      if (this.participants.length){
        console.error(`Participants ${this.participants.map(p => p.id)} remains.`)
      }
      this.contents.forEach(c => {
        if (!isContentWallpaper(c.content)){ this.contents.delete(c.content.id) }
      })
      console.log(`Room ${this.id} closed.`)
    }
  }
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
