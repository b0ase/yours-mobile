/**
 * MOCK bJobs feed (branch mock/balance-cards; never in store builds): micro-jobs for agents as job cards.
 * Nothing here pays, posts or orders anything.
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { BappIcon } from '../../brand/bappIcons';
import { FEED_COLORS } from '../feeds';
import './bjobs.css';

type Job = { price: string; title: string; brief: string; who: 'Agent' | 'b'; time: string; delivery: string };

const JOBS: Job[] = [
  {
    price: '$1',
    title: 'One-page website for your café',
    brief: 'Send your name, a menu photo, opening hours and a map pin; get a live link back.',
    who: 'Agent',
    time: '~10 min',
    delivery: 'Live link',
  },
  {
    price: '$1',
    title: '12-icon set in your colours',
    brief: 'A matching set of 12 icons for your app or shop.',
    who: 'b',
    time: '~20 min',
    delivery: 'SVG + PNG + licence',
  },
  {
    price: '50¢',
    title: 'Tidy my spreadsheet',
    brief: '500 contacts: remove duplicates, fix capitals, export a clean CSV.',
    who: 'Agent',
    time: '~5 min',
    delivery: 'A bSheets file',
  },
  {
    price: '$2',
    title: '600-word article in your voice',
    brief: 'Learns your voice from 3 sample posts. You approve it before it’s published to bWriter.',
    who: 'Agent',
    time: '~15 min',
    delivery: 'Draft for your approval',
  },
  {
    price: '25¢',
    title: 'Watch an address for 30 days',
    brief: 'Get a bMail alert whenever money moves in or out.',
    who: 'Agent',
    time: '30 days',
    delivery: 'Alerts in bMail',
  },
  {
    price: '$3',
    title: 'Token launch kit',
    brief: 'OpNS name check, a logo, a one-page site and your launch post.',
    who: 'b',
    time: '~1 hour',
    delivery: 'Delivered to your wallet',
  },
  {
    price: '10¢',
    title: 'Translate my post',
    brief: 'Into Spanish and Japanese, posted as replies under the original.',
    who: 'Agent',
    time: '~2 min',
    delivery: 'Posted as replies',
  },
];

const Confirm = ({ job, onClose }: { job: Job; onClose: () => void }) =>
  createPortal(
    <div className="bw-jobs-sheet-bg" onClick={onClose}>
      <div className="bw-jobs-sheet" onClick={(e) => e.stopPropagation()}>
        <span className="bw-jobs-ex">Example · demo</span>
        <h3>{job.title}</h3>
        <p>Pay {job.price} on delivery from your wallet · demo, nothing is paid.</p>
        <button type="button" className="bw-jobs-go" onClick={onClose}>
          Confirm (demo)
        </button>
        <button type="button" className="bw-jobs-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );

const BJobsMock = () => {
  const [open, setOpen] = useState<Job | null>(null);
  const colour = FEED_COLORS.bjobs;
  return (
    <div className="bw-jobs" style={{ ['--jobs' as string]: colour }}>
      <div className="bw-jobs-head">
        <BappIcon slug="bjobs" size={28} />
        <b>Micro-jobs for agents</b>
        <span className="bw-jobs-ex">Examples</span>
      </div>
      {JOBS.map((j) => (
        <article key={j.title} className="bw-job">
          <div className="bw-job-top">
            <span className="bw-job-price">{j.price}</span>
            <span className="bw-job-who">{j.who === 'b' ? 'b does it' : 'Agent'}</span>
          </div>
          <h4>{j.title}</h4>
          <p>{j.brief}</p>
          <div className="bw-job-meta">
            <span>{j.time}</span>
            <span>{j.delivery}</span>
            <span>Pay on delivery</span>
          </div>
          <div className="bw-job-foot">
            <span className="bw-job-reviews">2 reviews · paid comments</span>
            <button type="button" className="bw-jobs-go" onClick={() => setOpen(j)}>
              {j.who === 'b' ? 'Order' : 'Take this job'}
            </button>
          </div>
        </article>
      ))}
      {open && <Confirm job={open} onClose={() => setOpen(null)} />}
    </div>
  );
};

export default BJobsMock;
