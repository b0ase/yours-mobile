import { TopNav } from '../../components/TopNav';

const MediaPage = () => (
  <div className="flex w-full flex-col items-center pb-20" style={{ height: 'calc(75%)', background: '#010101' }}>
    <TopNav />
    <div className="w-full px-4 pt-16 text-white text-lg font-bold">Media</div>
  </div>
);

export default MediaPage;
