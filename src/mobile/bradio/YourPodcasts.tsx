import { useNavigate } from 'react-router-dom';
import { isOwned } from './podcasts';
import { PodcastCard } from './PodcastCard';
import { usePodcasts } from './usePodcasts';

/** Media: podcast NFTs in this wallet, playing the full recording (ownership proof). Nothing when you hold none. */
export const YourPodcasts = () => {
  const navigate = useNavigate();
  const { items, owned } = usePodcasts();
  const mine = (items ?? []).filter((p) => isOwned(p, owned));
  if (!mine.length) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-bold text-white m-0">Your podcasts</h2>
      <div className="grid gap-3 md:grid-cols-2">
        {mine.map((p) => (
          <PodcastCard key={p.id} p={p} owned onExpand={() => navigate('/m/media')} />
        ))}
      </div>
    </section>
  );
};
