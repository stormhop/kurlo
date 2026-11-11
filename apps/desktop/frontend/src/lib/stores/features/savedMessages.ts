import { clampName } from '../../constants';
import {
  requestTypeSupportsSavedMessages,
  savedMessageBytes,
  savedMessageProblem,
  socketIODraftFromMessage,
  socketIOMessageFromDraft,
  suggestedSavedMessageName,
  uniqueSavedMessageName,
  webSocketDraftFromMessage,
  webSocketMessageFromDraft,
} from '../../savedMessages';
import type { RawBodyType, RequestType, SavedRealtimeMessage, SIOArg } from '../../types/models';

type SavedMessagesHost = {
  requestType: RequestType;
  savedMessages: SavedRealtimeMessage[];
  bodyContent: string;
  sioEventName: string;
  sioArgs: SIOArg[];
  sioAck: boolean;
  sioSelectedArgId: string;
  webSocketConnected: boolean;
  socketIOConnected: boolean;
  webSocketMessageBodyType: () => RawBodyType | 'binary';
  setWebSocketMessageBodyType: (type: RawBodyType | 'binary') => void;
  webSocketSendCurrentMessage: () => Promise<void>;
  socketIOEmitCurrentMessage: () => Promise<void>;
  loadSavedMessage: (id: string) => boolean;
  saveCurrentMessageProblem: () => string;
};

export const savedMessagesFeature = {
  savedMessagesAvailable(this: SavedMessagesHost): boolean {
    return requestTypeSupportsSavedMessages(this.requestType);
  },

  suggestedSavedMessageName(this: SavedMessagesHost): string {
    return suggestedSavedMessageName(this.requestType, { event: this.sioEventName }, this.savedMessages);
  },

  saveCurrentMessageProblem(this: SavedMessagesHost): string {
    const draft = this.requestType === 'socketio' ? { event: this.sioEventName, args: this.sioArgs } : { content: this.bodyContent };
    return savedMessageProblem(this.savedMessages.length, savedMessageBytes(draft));
  },

  saveCurrentMessage(this: SavedMessagesHost, name: string): SavedRealtimeMessage | null {
    if (!requestTypeSupportsSavedMessages(this.requestType)) return null;
    if (this.saveCurrentMessageProblem()) return null;
    const message = this.requestType === 'socketio'
      ? socketIOMessageFromDraft(name, { event: this.sioEventName, args: this.sioArgs, ack: this.sioAck }, this.savedMessages)
      : webSocketMessageFromDraft(name, { content: this.bodyContent, type: this.webSocketMessageBodyType() }, this.savedMessages);
    this.savedMessages = [...this.savedMessages, message];
    return message;
  },

  loadSavedMessage(this: SavedMessagesHost, id: string): boolean {
    const message = this.savedMessages.find(item => item.id === id);
    if (!message) return false;
    if (this.requestType === 'socketio') {
      const draft = socketIODraftFromMessage(message);
      this.sioEventName = draft.event;
      this.sioArgs = draft.args;
      this.sioAck = draft.ack;
      this.sioSelectedArgId = draft.args[0]?.id ?? '1';
    } else {
      const draft = webSocketDraftFromMessage(message);
      this.setWebSocketMessageBodyType(draft.type);
      this.bodyContent = draft.content;
    }
    return true;
  },

  async sendSavedMessage(this: SavedMessagesHost, id: string) {
    if (!this.loadSavedMessage(id)) return;
    if (this.requestType === 'socketio') await this.socketIOEmitCurrentMessage();
    else await this.webSocketSendCurrentMessage();
  },

  renameSavedMessage(this: SavedMessagesHost, id: string, name: string) {
    const trimmed = clampName(name);
    if (!trimmed) return;
    this.savedMessages = this.savedMessages.map(item => item.id === id ? { ...item, name: uniqueSavedMessageName(trimmed, this.savedMessages, id) } : item);
  },

  deleteSavedMessage(this: SavedMessagesHost, id: string) {
    this.savedMessages = this.savedMessages.filter(item => item.id !== id);
  },
};
