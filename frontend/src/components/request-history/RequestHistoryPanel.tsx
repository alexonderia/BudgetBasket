import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import { useMemo, useState } from 'react';
import type { RequestLog } from '../../types';
import {
  filterLogsByLine,
  historyActionLabel,
  historyActorName,
  historyChanges,
  splitRequestLogs,
  type HistoryChange,
} from './requestHistory';

function HistoryChangeList({ changes, heading = false }: { changes: HistoryChange[]; heading?: boolean }) {
  return (
    <Stack className="request-history-changes" spacing={0.75}>
      {heading && (
        <Stack className="request-history-changes-heading" direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="caption" fontWeight={700}>Изменения</Typography>
          <Typography variant="caption" color="text.secondary">{changes.length} {changes.length === 1 ? 'поле' : 'поля'}</Typography>
        </Stack>
      )}
      {changes.map((change) => (
        <Box key={change.field} className="request-history-change">
          <Typography className="request-history-change-label" variant="caption" color="text.secondary">{change.field}</Typography>
          <Stack direction="row" spacing={0.75} alignItems="baseline" flexWrap="wrap" useFlexGap>
            <Typography className="request-history-change-old" variant="body2">{change.from}</Typography>
            <Typography variant="caption" color="text.secondary">→</Typography>
            <Typography className="request-history-change-new" variant="body2">{change.to}</Typography>
          </Stack>
        </Box>
      ))}
      {!changes.length && <Typography variant="body2" color="text.secondary">Изменений полей нет.</Typography>}
    </Stack>
  );
}

function HistoryEntry({
  entry,
  kindLabel,
}: {
  entry: RequestLog;
  kindLabel: string;
}) {
  const changes = historyChanges(entry);
  const isLineChange = !!entry.subject;
  const content = (
    <Stack className="request-history-entry-content" spacing={0.25}>
      <Typography className="request-history-kind" variant="overline" color="text.secondary" lineHeight={1.2}>{kindLabel}</Typography>
      <Typography className="request-history-action" fontWeight={700} lineHeight={1.35}>{historyActionLabel(entry.log.action)}</Typography>
      <Typography className="request-history-meta" variant="caption" color="text.secondary">
        {new Date(entry.created_at).toLocaleString('ru-RU')} · {historyActorName(entry.user)}
      </Typography>
      {isLineChange && (
        <>
          <Typography className="request-history-subject" variant="body2" sx={{ pt: 0.5 }}>
            <Box component="span" color="text.secondary">Строка: </Box>
            <Box component="span" fontWeight={700}>{entry.subject?.name || 'Наименование не указано'}</Box>
          </Typography>
          {(entry.subject?.category || entry.subject?.article) && (
            <Typography className="request-history-context" variant="caption" color="text.secondary">
              {[entry.subject?.category, entry.subject?.article].filter(Boolean).join(' · ')}
            </Typography>
          )}
        </>
      )}
      {entry.log.comment && (
        <Typography variant="body2" sx={{ pt: 0.25 }}>
          <Box component="span" color="text.secondary">Комментарий: </Box>
          {entry.log.comment}
        </Typography>
      )}
    </Stack>
  );

  if (isLineChange && changes.length > 0) {
    return (
      <Accordion disableGutters elevation={0} sx={{ borderBottom: 1, borderColor: 'divider', bgcolor: 'transparent', '&:before': { display: 'none' } }}>
        <AccordionSummary
          expandIcon={<ExpandMoreIcon fontSize="small" />}
          aria-controls={`request-log-${entry.id}-changes`}
          id={`request-log-${entry.id}-header`}
          sx={{ px: 0, py: 1.25, '& .MuiAccordionSummary-content': { my: 0 }, '& .MuiAccordionSummary-content.Mui-expanded': { my: 0 } }}
        >
          {content}
        </AccordionSummary>
        <AccordionDetails id={`request-log-${entry.id}-changes`} sx={{ px: 0, pt: 0, pb: 1.5 }}>
          <HistoryChangeList changes={changes} heading />
        </AccordionDetails>
      </Accordion>
    );
  }

  return (
    <Box sx={{ py: 1.5, borderBottom: 1, borderColor: 'divider' }}>
      {content}
      {!isLineChange && <HistoryChangeList changes={changes} />}
    </Box>
  );
}

export function RequestHistoryPanel({
  logs,
  loading = false,
  lineId,
  lineName,
  defaultTab = 'content',
  showTabs = true,
  embedded = false,
}: {
  logs: RequestLog[];
  loading?: boolean;
  lineId?: string;
  lineName?: string;
  defaultTab?: 'content' | 'approval';
  showTabs?: boolean;
  embedded?: boolean;
}) {
  const [tab, setTab] = useState<'content' | 'approval'>(defaultTab);
  const filteredLogs = useMemo(() => filterLogsByLine(logs, lineId, lineName), [lineId, lineName, logs]);
  const { content, approval } = useMemo(() => splitRequestLogs(filteredLogs), [filteredLogs]);

  if (loading) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ py: embedded ? 2 : 4 }}>
        <CircularProgress size={28} />
      </Stack>
    );
  }

  return (
    <Stack spacing={0} sx={{ minHeight: embedded ? 0 : undefined }}>
      {showTabs && (
        <Tabs
          value={tab}
          onChange={(_, value: 'content' | 'approval') => setTab(value)}
          variant="fullWidth"
          sx={{ px: embedded ? 0 : 1.5, borderBottom: 1, borderColor: 'divider', mb: 0.5 }}
        >
          <Tab value="content" label="Содержимое" />
          <Tab value="approval" label="Согласование" />
        </Tabs>
      )}
      <Stack sx={{ px: embedded ? 0 : 2.5, overflowY: embedded ? 'visible' : 'auto', maxHeight: embedded ? 420 : undefined }}>
        {(showTabs ? tab === 'content' : true) && content.map((entry) => (
          <HistoryEntry key={entry.id} entry={entry} kindLabel={entry.subject ? 'Строка заявки' : 'Заявка'} />
        ))}
        {(showTabs ? tab === 'content' : false) && !content.length && (
          <Typography sx={{ py: 2 }} color="text.secondary">Изменений содержимого пока нет.</Typography>
        )}
        {(showTabs ? tab === 'approval' : false) && approval.map((entry) => (
          <HistoryEntry key={entry.id} entry={entry} kindLabel="Согласование" />
        ))}
        {(showTabs ? tab === 'approval' : false) && !approval.length && (
          <Typography sx={{ py: 2 }} color="text.secondary">Событий согласования пока нет.</Typography>
        )}
      </Stack>
    </Stack>
  );
}
