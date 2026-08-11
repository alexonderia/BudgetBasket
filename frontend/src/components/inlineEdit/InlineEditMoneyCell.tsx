import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';
import { ClickToEditTrigger } from './ClickToEditTrigger';
import { inlineEditTextFieldSx } from './inlineEditStyles';

export function InlineEditMoneyCell({
  value,
  editable,
  onCommit,
  formatValue,
  parseValue,
  validate,
  ariaLabel = 'Сумма',
  title = 'Нажмите, чтобы изменить сумму',
}: {
  value: number;
  editable: boolean;
  onCommit: (amount: number) => void;
  formatValue: (amount: number) => string;
  parseValue: (raw: string) => number | null;
  validate?: (amount: number) => boolean;
  ariaLabel?: string;
  title?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => formatValue(value));

  useEffect(() => {
    if (!editing) setDraft(formatValue(value));
  }, [editing, value, formatValue]);

  const isValid = (amount: number | null) => amount !== null && (validate ? validate(amount) : true);

  const save = () => {
    const amount = parseValue(draft);
    if (!isValid(amount)) return;
    setEditing(false);
    if (amount !== value) onCommit(amount!);
  };

  if (!editable) {
    return (
      <Typography variant="body2" sx={{ fontSize: 13, textAlign: 'right' }}>
        {formatValue(value)}
      </Typography>
    );
  }

  if (!editing) {
    return (
      <ClickToEditTrigger align="right" title={title} onActivate={() => setEditing(true)}>
        {formatValue(value)}
      </ClickToEditTrigger>
    );
  }

  const parsed = parseValue(draft);
  return (
    <TextField
      autoFocus
      size="small"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      error={!isValid(parsed)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          save();
        }
        if (event.key === 'Escape') {
          setDraft(formatValue(value));
          setEditing(false);
        }
      }}
      onBlur={save}
      inputProps={{ inputMode: 'decimal', 'aria-label': ariaLabel }}
      sx={inlineEditTextFieldSx({ align: 'right' })}
    />
  );
}
