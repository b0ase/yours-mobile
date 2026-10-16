import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle } from 'lucide-react';
import { Theme } from '../theme.types';
import { Button } from './Button';
import { Show } from './Show';
import { PageLoader } from './PageLoader';
import { useState, useEffect } from 'react';
import { formatBsvAmount, fundingCopy } from '../services/bsv21FundGuard';

/**
 * Why sendBsv21 could not validate the transfer:
 * - not-active: the token's overlay is not funded, so nothing is validated
 * - queued: the overlay has the outputs but has not validated them yet
 * - not-valid: the overlay does not recognize enough of the outputs
 * - not-found: the overlay has never seen the token
 * - unseen: the overlay has not seen some of the outputs yet (e.g. just received)
 * - stale: the wallet lists outputs the overlay says are already spent
 * - unreachable: the token details lookup failed (sendBsv21 reports this as 'token-not-found'; it is not a verdict)
 */
export type Bsv21OverlayIssue =
  | 'not-active'
  | 'queued'
  | 'not-valid'
  | 'not-found'
  | 'unseen'
  | 'stale'
  | 'unreachable';

export type Bsv21OverlayPromptProps = {
  show: boolean;
  theme: Theme;
  issue: Bsv21OverlayIssue;
  tokenName: string;
  /** Exact satoshis the indexer's funding template asks for (not-active). Without it nothing can be paid. */
  fundingSats?: number;
  /** About how many future transfers the payment covers, from fee_per_output. */
  fundingCovers?: number;
  /** Why there is no amount (the template lookup failed). */
  fundingError?: string;
  processingMessage?: string;
  /** Pays exactly `sats`, after the second confirm here. */
  onFund: (sats: number) => void;
  /** Fetch the funding template again. */
  onRetryFunding?: () => void;
  /** stale: drop spent records, import valid change, send again. unseen: submit/rebroadcast unknown outputs, send again. */
  onFixAndSend?: () => void;
  /** unseen: the outpoints (txid.vout) the overlay doesn't know, listed under Details. */
  unseenOutpoints?: string[];
  /** unreachable: try the send again. */
  onRetry?: () => void;
  onSendUnverified: () => void;
  onCancel: () => void;
};

const WARN = '#F79009';

/** "8353949b…8804 #1" */
const shortOutpoint = (txid: string, vout: string | number) => `${txid.slice(0, 8)}…${txid.slice(-4)} #${vout}`;

const copy = (issue: Bsv21OverlayIssue, tokenName: string) => {
  switch (issue) {
    case 'not-active':
      return {
        title: 'Overlay not funded',
        body: `The ${tokenName} indexer isn't funded, so it can't confirm your tokens before you send them. Anyone can fund it; it then checks transfers for everyone holding ${tokenName}. You can also send without the check, for free.`,
      };
    case 'queued':
      return {
        title: 'Still validating',
        body: `The overlay is still working through ${tokenName} transfers and hasn't reached yours yet. Try again in a few minutes.`,
      };
    case 'not-valid':
      return {
        title: 'Tokens not validated',
        body: `The overlay doesn't recognize enough of your ${tokenName} as valid to cover this transfer.`,
      };
    case 'unseen':
      return {
        title: 'Not validated yet',
        body: `The overlay hasn't picked up some of your ${tokenName}. Usually the transfer that brought them was never passed to it, or never reached the chain. Fix and send passes it on (or broadcasts it again), then sends.`,
      };
    case 'stale':
      return {
        title: 'Wallet out of date',
        body: `Your ${tokenName} are fine, but this wallet's copy of them is out of date: it still lists tokens that were already sent, and may be missing the change. Fix and send updates this wallet from the indexer, then sends.`,
      };
    case 'unreachable':
      return {
        title: "Couldn't reach the indexer",
        body: `Couldn't reach the token indexer, so your ${tokenName} could not be checked. Nothing was sent. Try again.`,
      };
    case 'not-found':
      return {
        title: 'Unknown token',
        body: `The overlay has no record of ${tokenName}, so it can't confirm your tokens before you send them.`,
      };
  }
};

export const Bsv21OverlayPrompt = (props: Bsv21OverlayPromptProps) => {
  const {
    show,
    theme,
    issue,
    tokenName,
    fundingSats,
    fundingCovers,
    fundingError,
    processingMessage,
    onFund,
    onRetryFunding,
    onFixAndSend,
    unseenOutpoints,
    onRetry,
    onSendUnverified,
    onCancel,
  } = props;
  // Second step before any payment: the exact amount, not refundable, then Pay.
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!show || issue !== 'not-active') setConfirming(false);
  }, [show, issue, fundingSats]);
  const amountKnown = !!fundingSats && fundingSats > 0;

  const contrast = theme.color.global.contrast;
  const gray = theme.color.global.gray;
  const bg = theme.color.global.walletBackground;
  const base = copy(issue, tokenName);
  const { title, body } =
    confirming && amountKnown
      ? {
          title: `Pay ${formatBsvAmount(fundingSats!)}?`,
          body: `${fundingCopy(fundingSats!, tokenName, fundingCovers)} This does not send your tokens; send again after it is funded.`,
        }
      : base;
  const canFund = issue === 'not-active';

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="flex items-center justify-center"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            backgroundColor: bg,
            zIndex: 100,
          }}
        >
          <Show
            when={!!processingMessage}
            whenFalseContent={
              <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="flex flex-col items-center text-center px-6 w-full"
              >
                <div
                  className="flex items-center justify-center w-12 h-12 rounded-full mb-4"
                  style={{ backgroundColor: `${WARN}1F` }}
                >
                  <AlertTriangle size={24} style={{ color: WARN }} />
                </div>

                <h2 className="text-xl font-bold mb-2" style={{ color: contrast }}>
                  {title}
                </h2>
                <p className="text-sm mb-5 leading-relaxed" style={{ color: gray }}>
                  {body}
                </p>

                <Show when={canFund}>
                  <div className="w-full mb-5">
                    <div
                      className="flex justify-between items-center px-3 py-2 rounded-lg text-sm"
                      style={{ backgroundColor: `${contrast}08` }}
                    >
                      <span style={{ color: gray }}>Indexer fee</span>
                      <span className="font-semibold" style={{ color: amountKnown ? contrast : WARN }}>
                        {amountKnown ? formatBsvAmount(fundingSats!) : 'Unknown'}
                      </span>
                    </div>
                    <p className="text-[11px] mt-1.5 leading-relaxed text-left px-1" style={{ color: gray }}>
                      {amountKnown
                        ? fundingCopy(fundingSats!, tokenName, fundingCovers)
                        : (fundingError ?? "Couldn't get the indexer's price, so nothing can be paid.") +
                          ' Try again, or send unverified for free.'}
                    </p>
                  </div>
                </Show>

                <div className="flex flex-col items-center gap-2 w-[87%]">
                  {canFund ? (
                    amountKnown ? (
                      confirming ? (
                        <>
                          <Button
                            theme={theme}
                            type="primary"
                            label={`Pay ${formatBsvAmount(fundingSats!)}`}
                            onClick={() => onFund(fundingSats!)}
                          />
                          <Button
                            theme={theme}
                            type="secondary-outline"
                            label="Back"
                            onClick={() => setConfirming(false)}
                          />
                        </>
                      ) : (
                        <>
                          <Button
                            theme={theme}
                            type="primary"
                            label="Fund indexer"
                            onClick={() => setConfirming(true)}
                          />
                          <Button theme={theme} type="secondary-outline" label="Cancel" onClick={onCancel} />
                        </>
                      )
                    ) : (
                      <>
                        <Button theme={theme} type="primary" label="Fund indexer" disabled onClick={() => undefined} />
                        <Button
                          theme={theme}
                          type="secondary-outline"
                          label="Get price again"
                          onClick={() => onRetryFunding?.()}
                        />
                        <Button theme={theme} type="secondary-outline" label="Cancel" onClick={onCancel} />
                      </>
                    )
                  ) : (issue === 'stale' || issue === 'unseen') && onFixAndSend ? (
                    <>
                      <Button theme={theme} type="primary" label="Fix and send" onClick={onFixAndSend} />
                      <Button theme={theme} type="secondary-outline" label="Cancel" onClick={onCancel} />
                    </>
                  ) : issue === 'unreachable' && onRetry ? (
                    <>
                      <Button theme={theme} type="primary" label="Try again" onClick={onRetry} />
                      <Button theme={theme} type="secondary-outline" label="Cancel" onClick={onCancel} />
                    </>
                  ) : (
                    <Button theme={theme} type="primary" label="OK" onClick={onCancel} />
                  )}
                </div>

                <Show when={issue === 'unseen' && !!unseenOutpoints?.length}>
                  <details className="w-full mt-4 text-left">
                    <summary className="text-xs cursor-pointer" style={{ color: gray }}>
                      Details: {unseenOutpoints?.length} output{unseenOutpoints?.length === 1 ? '' : 's'} the indexer
                      doesn't know
                    </summary>
                    <ul className="mt-2 flex flex-col gap-1">
                      {(unseenOutpoints ?? []).map((op) => {
                        const [txid, vout] = op.replace('_', '.').split('.');
                        return (
                          <li key={op} className="text-[11px] font-mono">
                            <a
                              href={`https://whatsonchain.com/tx/${txid}`}
                              target="_blank"
                              rel="noreferrer"
                              style={{ color: contrast, textDecoration: 'underline' }}
                            >
                              {shortOutpoint(txid, vout)}
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                </Show>

                <div className="w-full mt-5 pt-4" style={{ borderTop: `1px solid ${gray}22` }}>
                  <p className="text-[11px] mb-2 leading-relaxed" style={{ color: gray }}>
                    Sending unverified skips the check. If any token it spends is invalid, the whole transfer is invalid
                    and every token in it is lost.
                  </p>
                  <button
                    type="button"
                    onClick={onSendUnverified}
                    className="text-xs font-semibold bg-transparent border-0 outline-none cursor-pointer"
                    style={{ color: WARN }}
                  >
                    Send unverified anyway
                  </button>
                </div>
              </motion.div>
            }
          >
            <PageLoader theme={theme} message={processingMessage} />
          </Show>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
