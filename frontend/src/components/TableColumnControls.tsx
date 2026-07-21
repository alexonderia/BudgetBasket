import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import ViewColumnOutlinedIcon from '@mui/icons-material/ViewColumnOutlined';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Popover from '@mui/material/Popover';
import Stack from '@mui/material/Stack';
import TableSortLabel from '@mui/material/TableSortLabel';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import type {
  TableColumnDefinition,
  TableFilterOption,
  TableSortDirection,
} from '../utils/tableColumns';

type ColumnMeta<K extends string> = Pick<TableColumnDefinition<unknown, K>, 'id' | 'label' | 'hideable'>;

export function TableColumnTools<K extends string>({
  columns,
  visibility,
  onToggleColumn,
  onResetColumns,
  onResetFilters,
  hasActiveFilters = false,
}: {
  columns: ColumnMeta<K>[];
  visibility: Record<K, boolean>;
  onToggleColumn: (columnId: K) => void;
  onResetColumns?: () => void;
  onResetFilters?: () => void;
  hasActiveFilters?: boolean;
}) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const visibleHideableCount = columns.filter((column) => column.hideable !== false && visibility[column.id]).length;
  const hasHiddenColumns = columns.some((column) => column.hideable !== false && visibility[column.id] === false);

  return (
    <>
      <Tooltip title="Настройки таблицы">
        <IconButton
          size="small"
          color={hasActiveFilters || hasHiddenColumns ? 'primary' : 'default'}
          onClick={(event) => setAnchorEl(event.currentTarget)}
          aria-label="Настройки таблицы"
        >
          <SettingsOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchorEl} open={!!anchorEl} onClose={() => setAnchorEl(null)}>
        <MenuItem disabled>
          <ViewColumnOutlinedIcon fontSize="small" />
          <ListItemText sx={{ ml: 1 }}>Колонки</ListItemText>
        </MenuItem>
        {columns.map((column) => {
          const checked = visibility[column.id] ?? true;
          const disableHide = column.hideable === false || (checked && visibleHideableCount === 1);
          return (
            <MenuItem key={column.id} onClick={() => !disableHide && onToggleColumn(column.id)} disabled={disableHide}>
              <Checkbox edge="start" checked={checked} disableRipple disabled={disableHide} />
              <ListItemText>{column.label}</ListItemText>
            </MenuItem>
          );
        })}
        {(onResetColumns || onResetFilters) && (
          <>
            <Divider />
            <MenuItem onClick={() => { onResetColumns?.(); onResetFilters?.(); setAnchorEl(null); }}>
              <ListItemText>Сбросить настройки таблицы</ListItemText>
            </MenuItem>
          </>
        )}
      </Menu>
    </>
  );
}

export function TableColumnHeader({
  label,
  sortable = true,
  filterable = true,
  sortDirection = null,
  onSortAscending,
  onSortDescending,
  onClearSort,
  filterOptions = [],
  selectedFilterValues = null,
  filterSearchValue = '',
  onFilterSearchChange,
  onToggleFilterValue,
  onSelectAllFilterValues,
  onClearColumnFilter,
  onClearVisibleFilterValues,
  endAdornment,
}: {
  label: string;
  sortable?: boolean;
  filterable?: boolean;
  sortDirection?: TableSortDirection | null;
  onSortAscending?: () => void;
  onSortDescending?: () => void;
  onClearSort?: () => void;
  filterOptions?: TableFilterOption[];
  selectedFilterValues?: string[] | null;
  filterSearchValue?: string;
  onFilterSearchChange?: (value: string) => void;
  onToggleFilterValue?: (value: string) => void;
  onSelectAllFilterValues?: () => void;
  onClearColumnFilter?: () => void;
  onClearVisibleFilterValues?: () => void;
  endAdornment?: ReactNode;
}) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const selectedValues = selectedFilterValues ?? filterOptions.map((option) => option.value);
  const allVisibleSelected = filterOptions.length > 0 && filterOptions.every((option) => selectedValues.includes(option.value));
  const columnFiltered = selectedFilterValues !== null;
  const columnSorted = !!sortDirection;
  const menuActive = columnFiltered;

  const filterSummary = useMemo(() => {
    if (!columnFiltered) return 'Все значения';
    if (selectedValues.length === 0) return 'Нет выбранных значений';
    if (selectedValues.length === 1) {
      return filterOptions.find((option) => option.value === selectedValues[0])?.label || '1 значение';
    }
    return `Выбрано: ${selectedValues.length}`;
  }, [columnFiltered, filterOptions, selectedValues]);

  const openFilterMenu = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    setAnchorEl(event.currentTarget);
  };

  const toggleSort = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    if (!onSortAscending) return;
    if (sortDirection === 'asc') {
      onSortDescending?.();
    } else if (sortDirection === 'desc') {
      onClearSort?.();
    } else {
      onSortAscending();
    }
  };

  return (
    <>
      <Stack direction="row" spacing={0.25} alignItems="center" sx={{ minWidth: 0, pr: endAdornment ? 1.5 : 0 }}>
        {sortable ? (
          <TableSortLabel
            active={columnSorted}
            direction={sortDirection ?? 'asc'}
            onClick={toggleSort}
            sx={{ minWidth: 0, '& .MuiTableSortLabel-icon': { fontSize: 16 } }}
          >
            <Typography component="span" variant="body2" fontWeight={600} sx={{ whiteSpace: 'nowrap' }}>
              {label}
            </Typography>
          </TableSortLabel>
        ) : (
          <Typography component="span" variant="body2" fontWeight={600} sx={{ whiteSpace: 'nowrap' }}>
            {label}
          </Typography>
        )}
        {filterable && (
          <Tooltip title={menuActive ? filterSummary : 'Фильтр'}>
            <IconButton size="small" color={menuActive ? 'primary' : 'default'} onClick={openFilterMenu} sx={{ ml: 'auto' }}>
              {columnFiltered ? <FilterAltOutlinedIcon fontSize="inherit" /> : <ArrowDropDownIcon fontSize="inherit" />}
            </IconButton>
          </Tooltip>
        )}
        {endAdornment}
      </Stack>
      <Popover
        open={!!anchorEl}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      >
        <Stack spacing={1.25} sx={{ p: 1.5, width: 320 }}>
          <Typography variant="subtitle2">{label}</Typography>

          {filterable && (
            <>
              <TextField
                size="small"
                label="Поиск значений"
                value={filterSearchValue}
                onChange={(event) => onFilterSearchChange?.(event.target.value)}
                autoFocus
              />
              <Stack direction="row" spacing={1} justifyContent="space-between">
                <Button size="small" onClick={onSelectAllFilterValues}>
                  Выбрать все
                </Button>
                <Button size="small" onClick={onClearVisibleFilterValues} disabled={filterOptions.length === 0 || !allVisibleSelected}>
                  Снять видимые
                </Button>
                <Button size="small" onClick={onClearColumnFilter} disabled={!columnFiltered}>
                  Сбросить
                </Button>
              </Stack>
              <Stack spacing={0} sx={{ maxHeight: 280, overflowY: 'auto', border: '1px solid rgba(15, 23, 42, 0.08)', borderRadius: 1 }}>
                {filterOptions.length > 0 ? (
                  filterOptions.map((option) => {
                    const checked = selectedValues.includes(option.value);
                    return (
                      <MenuItem key={option.value} dense onClick={() => onToggleFilterValue?.(option.value)}>
                        <Checkbox edge="start" checked={checked} disableRipple />
                        <ListItemText
                          primary={option.label}
                          secondary={option.count > 1 ? `${option.count} строк` : '1 строка'}
                        />
                      </MenuItem>
                    );
                  })
                ) : (
                  <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
                    Значения не найдены
                  </Typography>
                )}
              </Stack>
            </>
          )}
        </Stack>
      </Popover>
    </>
  );
}
