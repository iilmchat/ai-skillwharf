import { MessageBody, SubscribeMessage, WebSocketGateway, WsException } from '@nestjs/websockets';
import { ChatService, type ChatReply } from './chat.service.js';

export interface SendMessagePayload {
  conversationId: string;
  content: string;
}

@WebSocketGateway({ cors: true })
export class ChatGateway {
  constructor(private readonly chatService: ChatService) {}

  @SubscribeMessage('send_message')
  async handleSendMessage(@MessageBody() payload: SendMessagePayload): Promise<ChatReply> {
    if (
      !payload ||
      typeof payload.conversationId !== 'string' ||
      typeof payload.content !== 'string' ||
      payload.content.trim() === ''
    ) {
      throw new WsException('Ожидается { conversationId, content }');
    }

    return this.chatService.handleMessage(payload.conversationId, payload.content);
  }
}
