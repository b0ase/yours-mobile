import { createRoot } from 'react-dom/client';
import { JustBIntro } from './JustBIntro';

export const mountJustBIntro = () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  createRoot(host).render(<JustBIntro />);
};
