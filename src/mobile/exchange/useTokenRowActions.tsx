/** Hooks for Exchange token-row actions (TokenRowActions.tsx renders them). */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Info, MessageCircle, ShoppingCart } from 'lucide-react';
import type { SwipeAction } from '../swipe/SwipeRow';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { requestChatRoom } from '../chat/nav';
import { heldBsv21Balances } from '../airdrops/heldBalances';
import { useBackClose } from '../backStack';
import { buyRoute, chatDecision, heldTokenIds, infoRoute } from './rowActions';
import { HoldHint } from './TokenRowActions';

/** Token IDs this wallet holds; null while loading or when the wallet cannot be read. */
export const useHeldTokenIds = (): ReadonlySet<string> | null => {
  const { apiContext } = useServiceContext();
  const [held, setHeld] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    let live = true;
    heldBsv21Balances(apiContext)
      .then((b) => live && setHeld(heldTokenIds(b)))
      .catch(() => live && setHeld(new Set()));
    return () => {
      live = false;
    };
  }, [apiContext]);
  return held;
};

type HintTarget = { id: string; title: string };

/** Shared state for one list: the held set and the "Hold some to enter" sheet. */
export const useTokenRowActions = () => {
  const navigate = useNavigate();
  const { handleSelect } = useBottomMenu();
  const held = useHeldTokenIds();
  const [hint, setHint] = useState<HintTarget | null>(null);
  useBackClose(!!hint, () => setHint(null));

  const openRoom = useCallback(
    (roomKey: string) => {
      requestChatRoom(roomKey);
      handleSelect(asMenuItem('chat'));
    },
    [handleSelect],
  );

  // Holdings were still loading when Chat was tapped: open the room as soon as they say we hold it.
  useEffect(() => {
    if (!hint) return;
    const d = chatDecision(hint.id, held);
    if (d.kind === 'open') {
      setHint(null);
      openRoom(d.roomKey);
    }
  }, [hint, held, openRoom]);

  const actionsFor = (id: string, title: string): SwipeAction[] => [
    {
      id: 'chat',
      label: 'Chat',
      icon: <MessageCircle size={18} />,
      color: 'var(--bw-accent)',
      fg: 'var(--bw-on-accent)',
      onPress: () => {
        const d = chatDecision(id, held);
        if (d.kind === 'open') openRoom(d.roomKey);
        else setHint({ id, title });
      },
    },
    {
      id: 'buy',
      label: 'Buy',
      icon: <ShoppingCart size={18} />,
      color: 'var(--bw-accent-lo)',
      fg: 'var(--bw-text)',
      onPress: () => navigate(buyRoute(id)),
    },
    {
      id: 'info',
      label: 'Info',
      icon: <Info size={18} />,
      color: 'var(--bw-card2, var(--bw-card))',
      fg: 'var(--bw-text)',
      onPress: () => navigate(infoRoute(id)),
    },
  ];

  const sheet = hint ? (
    <HoldHint
      title={hint.title}
      checking={held === null}
      onBuy={() => {
        const id = hint.id;
        setHint(null);
        navigate(buyRoute(id));
      }}
      onClose={() => setHint(null)}
    />
  ) : null;

  return { actionsFor, sheet };
};
