export const MessageTypeAccumulating:{[name: string]: string} = {
  CONTENT_UPDATE_REQUEST: 'content_update',     //  -> message
  CONTENT_REMOVE_REQUEST: 'content_remove',     //  -> message
  LEFT_CONTENT_REMOVE_REQUEST: 'left_content_remove',     //  -> message
}
export const MessageTypeAccumulatingSet = new Set()
for(const key in MessageTypeAccumulating){
  MessageTypeAccumulatingSet.add(MessageTypeAccumulating[key])
}


export const MessageTypeInstant:{[name: string]: string} = {
  CHAT_MESSAGE: 'm_chat',                       //  -> text chat message
  PARTICIPANT_TRACKLIMITS: 'm_track_limits',    //  -> message, basically does not sync
  YARN_PHONE: 'YARN_PHONE',                     //  -> message
  CALL_REMOTE: 'call_remote',                   //  -> message, to give notification to a remote user.
  ...MessageTypeAccumulating
}

export const messageTypeInstantSet = new Set()
for(const key in MessageTypeInstant){
  messageTypeInstantSet.add(MessageTypeInstant[key])
}
export const MessageTypeSpecial = {
  REQUEST: 'request',
  REQUEST_TO: 'request_to',
  PARTICIPANT_LEFT: 'm_participant_left',       //  -> remove info
  SET_PERIOD: 'set_period',
}
export const MessageTypeStore:{[name: string]: string} = {
  PARTICIPANT_POSE: 'mp',                       //  -> update presence once per 5 sec / message immediate value
  PARTICIPANT_MOUSE: 'mm',                      //  -> message
  AFK_CHANGED: 'afk_changed',                   //
  PARTICIPANT_INFO: 'p_info',                   //  -> presence
  PARTICIPANT_PHYSICS: 'p_physics',             //  -> presence
  PARTICIPANT_TRACKSTATES: 'p_trackstates',     //  -> presence
  MAIN_SCREEN_CARRIER: 'main_screen_carrier',   //  -> presence
  MY_CONTENT: 'my_content',                     //  -> presence
}
export const messageTypeStoreSet = new Set()
for(const key in MessageTypeStore){
  messageTypeStoreSet.add(MessageTypeStore[key])
}

export interface Message {
  t: string,  //  type
  r: string,  //  room id
  p: string,  //  source pid
  d: string,  //  distination pid
  v: string,  //  JSON value
}

