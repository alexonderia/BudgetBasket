import CloseIcon from '@mui/icons-material/Close';
import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { RequestLog } from '../../types';
import { RequestHistoryPanel } from './RequestHistoryPanel';

export function RegisterHistoryDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: logs = [], isPending } = useQuery({
    queryKey: ['approval-register-history'],
    queryFn: async () => (await api.get<RequestLog[]>('/approval-register/history')).data,
    enabled: open,
  });

  return (
    <Drawer anchor="right" open={open} onClose={onClose} PaperProps={{ className: 'request-history-drawer' }}>
      <Stack className="request-chat-header" direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
        <Box minWidth={0}>
          <Typography variant="h6" noWrap>Общая история</Typography>
          <Typography variant="body2" color="text.secondary" noWrap>Изменения и согласование доступных вам заявок</Typography>
        </Box>
        <IconButton onClick={onClose} aria-label="Закрыть историю"><CloseIcon /></IconButton>
      </Stack>
      <RequestHistoryPanel logs={logs} loading={isPending} />
    </Drawer>
  );
}
