import Box from '@mui/material/Box';
import type { ReactNode } from 'react';
import { clickToEditTriggerSx, INLINE_EDIT_SAVE_HINT } from './inlineEditStyles';

export function ClickToEditTrigger({
  children,
  title,
  align = 'left',
  emphasized = true,
  fontStyle,
  onActivate,
}: {
  children: ReactNode;
  title?: string;
  align?: 'left' | 'right' | 'center';
  emphasized?: boolean;
  fontStyle?: 'italic';
  onActivate: () => void;
}) {
  return (
    <Box
      component="button"
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onActivate();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onActivate();
      }}
      title={title ?? INLINE_EDIT_SAVE_HINT}
      sx={clickToEditTriggerSx({ align, emphasized, fontStyle })}
    >
      {children}
    </Box>
  );
}
