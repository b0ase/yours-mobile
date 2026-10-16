import { useEffect, useMemo, useState } from 'react';
import { sharedChatClient } from '../chat/sharedRooms';
import { PhoneApi, type MyPhone } from './phoneApi';

export const usePhoneApi = () =>
  useMemo(() => new PhoneApi((m, p, b, a) => sharedChatClient().request(m, p, b, a)), []);

/** null while loading, false when SMS is off, else the state. */
export const usePhoneAvailable = (api: PhoneApi) => {
  const [state, setState] = useState<{ phone: MyPhone | null } | false | null>(null);
  useEffect(() => {
    let live = true;
    api
      .available()
      .then((r) => live && setState(r ?? false))
      .catch(() => live && setState(false));
    return () => void (live = false);
  }, [api]);
  return [state, setState] as const;
};
