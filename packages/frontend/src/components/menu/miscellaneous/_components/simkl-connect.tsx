import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@aiostreams/ui/button';
import { toast } from 'sonner';
import { useUserData } from '@/context/userData';
import {
  getSimklStatus,
  startSimklConnection,
  pollSimklConnection,
  disconnectSimkl,
} from '@/lib/api';

export function SimklConnect({ variant }: { variant: string }) {
  const { uuid, password } = useUserData();
  const credentials = { uuid: uuid ?? '', password };
  const status = useQuery({
    queryKey: ['simkl-connection', uuid, variant],
    queryFn: () => getSimklStatus(credentials, variant),
    enabled: Boolean(uuid),
    retry: false,
  });
  const [flow, setFlow] =
    useState<Awaited<ReturnType<typeof startSimklConnection>>>();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Simkl request failed.'
      );
    } finally {
      setBusy(false);
    }
  }

  if (!uuid) return <p>Save your configuration before connecting Simkl.</p>;
  if (status.isPending) return <p>Checking Simkl connection…</p>;
  if (status.isError)
    return <p>Sign in to your saved configuration to manage Simkl.</p>;
  if (!status.data.configured)
    return (
      <p>
        Ask the instance administrator to set SIMKL_CLIENT_ID before connecting
        Simkl.
      </p>
    );

  return (
    <div className="space-y-2">
      {status.data.connected ? (
        <>
          <p>Simkl connected for this configuration scope.</p>
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await disconnectSimkl(credentials, variant);
                setFlow(undefined);
                await status.refetch();
              })
            }
          >
            Disconnect Simkl
          </Button>
        </>
      ) : (
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setFlow(await startSimklConnection(credentials, variant));
              setPending(false);
            })
          }
        >
          {flow ? 'Get a new code' : 'Connect Simkl'}
        </Button>
      )}
      {flow && (
        <div className="space-y-2">
          <p>
            Open{' '}
            <a
              className="underline"
              href={flow.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Simkl
            </a>{' '}
            and approve code <strong>{flow.code}</strong>.
          </p>
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await pollSimklConnection(credentials, variant);
                setPending(!result.connected);
                if (result.connected) {
                  setFlow(undefined);
                  await status.refetch();
                }
              })
            }
          >
            Check authorization
          </Button>
          {pending && (
            <p>
              Waiting for approval. Once you’ve approved on Simkl, wait a few
              seconds and check again.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
