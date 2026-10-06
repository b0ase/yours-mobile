import { asMenuItem } from '../tabs/tabs';
import { requestChatRoom } from '../chat/nav';

export const openTicketRoomInChat = (tokenId: string, select: (item: ReturnType<typeof asMenuItem>) => void) => {
  requestChatRoom(`bsv21:${tokenId}`);
  select(asMenuItem('chat'));
};
