import { YoursNative } from '../native';
import { canOpenSettings, deniedText, type MediaKind } from './mediaPermission';
import { mediaPlatform, useOnResume } from './useOnResume';

/**
 * A denied mic/camera note with an "Open Settings" button (native only). Stays until dismissed
 * or the permission is fixed; `onRetry` runs when the app returns to the foreground.
 */
export const MediaPermissionNote = ({
  kind,
  onRetry,
  onDismiss,
  className,
  style,
}: {
  kind: MediaKind;
  onRetry: () => void;
  onDismiss?: () => void;
  className?: string;
  style?: React.CSSProperties;
}) => {
  const platform = mediaPlatform();
  useOnResume(onRetry);
  return (
    <div role="alert" className={className} style={style}>
      <p>{deniedText(kind, platform)}</p>
      <div className="mt-2 flex gap-2 justify-end">
        {onDismiss && (
          <button onClick={onDismiss} className="rounded-lg px-3 py-1.5 text-sm" style={{ color: '#98A2B3' }}>
            Dismiss
          </button>
        )}
        {canOpenSettings(platform) && (
          <button
            onClick={() => void YoursNative.openAppSettings().catch(() => undefined)}
            className="rounded-lg px-3 py-1.5 text-sm font-semibold"
            style={{ background: '#F5B800', color: '#000' }}
          >
            Open Settings
          </button>
        )}
      </div>
    </div>
  );
};
