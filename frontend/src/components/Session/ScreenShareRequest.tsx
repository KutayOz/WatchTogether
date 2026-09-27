import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ScreenIcon } from '../ui/icons';

interface ScreenShareRequestProps {
  requesterName: string;
  onApprove: () => void;
  onDeny: () => void;
}

/**
 * The other person asking to put their screen up. A decision, so it cannot
 * be dismissed by a stray click — it takes an answer either way, and the
 * asker hears it.
 */
export function ScreenShareRequest({ requesterName, onApprove, onDeny }: ScreenShareRequestProps) {
  return (
    <Modal
      isOpen
      onClose={onDeny}
      dismissible={false}
      hideClose
      width={440}
      title={`${requesterName} wants to share their screen`}
      description="Their screen replaces the picture on the stage until they stop."
      footer={
        <>
          <Button variant="ghost" onClick={onDeny}>
            Not now
          </Button>
          <Button variant="teal" icon={<ScreenIcon size={18} />} onClick={onApprove} data-autofocus="">
            Allow
          </Button>
        </>
      }
    />
  );
}
