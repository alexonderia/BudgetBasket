import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import CloseIcon from '@mui/icons-material/Close';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useAppToast } from '../components/Layout';
import type { Role, Unit, User } from '../types';
import { roleLabels } from '../utils/labels';
import { EMAIL_RE, PHONE_RE, formatPhone, lettersOnly } from '../utils/validation';

const emptyForm = {
  login: '',
  password: '',
  role: 'employee' as Role,
  last_name: '',
  name: '',
  second_name: '',
  phone: '',
  email: '',
  max_link: '',
};

type CreateForm = typeof emptyForm;

type UserDraft = {
  login: string;
  role: Role;
  last_name: string;
  name: string;
  second_name: string;
  phone: string;
  email: string;
  max_link: string;
};

const emptyDraft = (): UserDraft => ({
  login: '',
  role: 'employee',
  last_name: '',
  name: '',
  second_name: '',
  phone: '',
  email: '',
  max_link: '',
});

function draftFromUser(user: User): UserDraft {
  return {
    login: user.login,
    role: user.role,
    last_name: user.profile?.last_name || '',
    name: user.profile?.name || '',
    second_name: user.profile?.second_name || '',
    phone: user.profile?.phone || '',
    email: user.profile?.email || '',
    max_link: user.profile?.max_link || '',
  };
}

function getErrorMessage(error: unknown, fallback: string) {
  const detail = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
  return detail || (error instanceof Error ? error.message : fallback);
}

function ProfileSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box className="profile-form-section">
      <Typography className="profile-form-section-title" sx={{ mb: 1.5 }}>{title}</Typography>
      <Stack spacing={1.75}>{children}</Stack>
    </Box>
  );
}

function CreateUserDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useAppToast();
  const [form, setForm] = useState<CreateForm>(emptyForm);

  useEffect(() => {
    if (open) setForm(emptyForm);
  }, [open]);

  const create = useMutation({
    mutationFn: () => api.post('/users', form),
    onSuccess: () => {
      toast('Пользователь создан', 'success');
      onCreated();
      onClose();
    },
    onError: (error) => {
      toast(getErrorMessage(error, 'Не удалось создать пользователя'), 'error');
    },
  });

  const setField = <K extends keyof CreateForm>(key: K, value: CreateForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };
  const invalidContact = (form.email && !EMAIL_RE.test(form.email)) || (form.phone && !PHONE_RE.test(form.phone));

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" className="profile-dialog">
      <DialogTitle sx={{ pr: 6, pb: 1.5 }}>
        Создать профиль
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 12, top: 12 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent
        dividers
        sx={{
          p: 0,
          overflowY: 'auto',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          '&::-webkit-scrollbar': { display: 'none' },
        }}
      >
        <Stack spacing={0} sx={{ px: 3, py: 2.5 }}>
          <ProfileSection title="Основное">
            <TextField label="Фамилия" value={form.last_name} onChange={(e) => setField('last_name', lettersOnly(e.target.value))} fullWidth />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.75}>
              <TextField label="Имя" value={form.name} onChange={(e) => setField('name', lettersOnly(e.target.value))} fullWidth autoFocus />
              <TextField label="Отчество" value={form.second_name} onChange={(e) => setField('second_name', lettersOnly(e.target.value))} fullWidth />
            </Stack>
          </ProfileSection>

          <Divider sx={{ my: 2.5 }} />

          <ProfileSection title="Контакты">
            <TextField label="Email" type="email" value={form.email} onChange={(e) => setField('email', e.target.value)} error={!!form.email && !EMAIL_RE.test(form.email)} helperText={form.email && !EMAIL_RE.test(form.email) ? 'Введите email в формате name@example.ru' : undefined} fullWidth />
            <TextField label="Телефон" value={form.phone} onChange={(e) => setField('phone', formatPhone(e.target.value))} error={!!form.phone && !PHONE_RE.test(form.phone)} helperText={form.phone && !PHONE_RE.test(form.phone) ? 'Формат: +7 (000) 000-00-00' : undefined} fullWidth />
            <TextField
              label="Ссылка Max"
              value={form.max_link}
              onChange={(e) => setField('max_link', e.target.value)}
              fullWidth
              placeholder="https://max.ru/..."
            />
          </ProfileSection>

          <Divider sx={{ my: 2.5 }} />

          <ProfileSection title="Доступ">
            <TextField label="Логин" value={form.login} onChange={(e) => setField('login', e.target.value)} fullWidth />
            <TextField label="Пароль" type="password" value={form.password} onChange={(e) => setField('password', e.target.value)} fullWidth />
            <TextField select label="Роль" value={form.role} onChange={(e) => setField('role', e.target.value as Role)} fullWidth>
              {Object.entries(roleLabels).map(([value, label]) => (
                <MenuItem key={value} value={value}>{label}</MenuItem>
              ))}
            </TextField>
          </ProfileSection>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose}>Отмена</Button>
        <Button
          startIcon={<AddIcon />}
          variant="contained"
          onClick={() => create.mutate()}
          disabled={!form.login || !form.password || invalidContact || create.isPending}
        >
          Создать профиль
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function EditUserDialog({
  user,
  onClose,
  onSaved,
}: {
  user: User | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useAppToast();
  const [form, setForm] = useState<UserDraft>(emptyDraft());

  useEffect(() => {
    if (user) setForm(draftFromUser(user));
  }, [user]);

  const save = useMutation({
    mutationFn: () => api.patch(`/users/${user?.id}`, form),
    onSuccess: () => {
      toast('Изменения пользователя сохранены', 'success');
      onSaved();
      onClose();
    },
    onError: (error) => {
      toast(getErrorMessage(error, 'Не удалось сохранить пользователя'), 'error');
    },
  });

  const setField = <K extends keyof UserDraft>(key: K, value: UserDraft[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };
  const invalidContact = (form.email && !EMAIL_RE.test(form.email)) || (form.phone && !PHONE_RE.test(form.phone));

  return (
    <Dialog open={!!user} onClose={onClose} fullWidth maxWidth="sm" className="profile-dialog">
      <DialogTitle sx={{ pr: 6, pb: 1.5 }}>
        Редактировать пользователя
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 12, top: 12 }} aria-label="Закрыть">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent
        dividers
        sx={{
          p: 0,
          overflowY: 'auto',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          '&::-webkit-scrollbar': { display: 'none' },
        }}
      >
        <Stack spacing={0} sx={{ px: 3, py: 2.5 }}>
          <ProfileSection title="Основное">
            <TextField label="Фамилия" value={form.last_name} onChange={(e) => setField('last_name', lettersOnly(e.target.value))} fullWidth />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.75}>
              <TextField label="Имя" value={form.name} onChange={(e) => setField('name', lettersOnly(e.target.value))} fullWidth autoFocus />
              <TextField label="Отчество" value={form.second_name} onChange={(e) => setField('second_name', lettersOnly(e.target.value))} fullWidth />
            </Stack>
          </ProfileSection>

          <Divider sx={{ my: 2.5 }} />

          <ProfileSection title="Контакты">
            <TextField label="Email" type="email" value={form.email} onChange={(e) => setField('email', e.target.value)} error={!!form.email && !EMAIL_RE.test(form.email)} helperText={form.email && !EMAIL_RE.test(form.email) ? 'Введите email в формате name@example.ru' : undefined} fullWidth />
            <TextField label="Телефон" value={form.phone} onChange={(e) => setField('phone', formatPhone(e.target.value))} error={!!form.phone && !PHONE_RE.test(form.phone)} helperText={form.phone && !PHONE_RE.test(form.phone) ? 'Формат: +7 (000) 000-00-00' : undefined} fullWidth />
            <TextField label="Ссылка Max" value={form.max_link} onChange={(e) => setField('max_link', e.target.value)} fullWidth placeholder="https://max.ru/..." />
          </ProfileSection>

          <Divider sx={{ my: 2.5 }} />

          <ProfileSection title="Доступ">
            <TextField label="Логин" value={form.login} onChange={(e) => setField('login', e.target.value)} fullWidth />
            <TextField select label="Роль" value={form.role} onChange={(e) => setField('role', e.target.value as Role)} fullWidth>
              {Object.entries(roleLabels).map(([value, label]) => (
                <MenuItem key={value} value={value}>{label}</MenuItem>
              ))}
            </TextField>
          </ProfileSection>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose} disabled={save.isPending}>Отмена</Button>
        <Button variant="contained" onClick={() => save.mutate()} disabled={!form.login.trim() || invalidContact || save.isPending}>
          Сохранить
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function UsersPage() {
  const queryClient = useQueryClient();
  const toast = useAppToast();
  const { data = [] } = useQuery({ queryKey: ['users'], queryFn: async () => (await api.get<User[]>('/users')).data });
  const { data: units = [] } = useQuery({ queryKey: ['units'], queryFn: async () => (await api.get<Unit[]>('/units')).data });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [roleFilter, setRoleFilter] = useState<Role | ''>('');
  const [unitFilter, setUnitFilter] = useState('');

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const unitNames = useMemo(() => new Map(units.map((unit) => [unit.id, unit.name])), [units]);
  const filteredUsers = useMemo(
    () => data.filter((user) =>
      (!roleFilter || user.role === roleFilter) &&
      (!unitFilter || user.unit_ids?.includes(unitFilter)),
    ),
    [data, roleFilter, unitFilter],
  );

  const deleteUser = useMutation({
    mutationFn: (id: string) => api.delete(`/users/${id}`),
    onSuccess: (_data, deletedId) => {
      toast('Пользователь удалён', 'success');
      setDeleteTarget(null);
      if (editingUser?.id === deletedId) {
        setEditingUser(null);
      }
      refresh();
    },
    onError: (error) => {
      toast(getErrorMessage(error, 'Не удалось удалить пользователя'), 'error');
    },
  });

  return (
    <Stack spacing={3}>
      <Paper className="table-surface" sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} justifyContent="space-between" alignItems={{ sm: 'center' }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              select
              label="Роль"
              value={roleFilter}
              onChange={(event) => setRoleFilter(event.target.value as Role | '')}
              sx={{ minWidth: 220 }}
            >
              <MenuItem value="">Все роли</MenuItem>
              {Object.entries(roleLabels).map(([value, label]) => (
                <MenuItem key={value} value={value}>{label}</MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="Подразделение"
              value={unitFilter}
              onChange={(event) => setUnitFilter(event.target.value)}
              sx={{ minWidth: 260 }}
            >
              <MenuItem value="">Все подразделения</MenuItem>
              {units.map((unit) => (
                <MenuItem key={unit.id} value={unit.id}>
                  {unit.parent_id ? `${unitNames.get(unit.parent_id) || ''} / ${unit.name}` : unit.name}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          <Button startIcon={<AddIcon />} variant="contained" onClick={() => setDialogOpen(true)}>
            Добавить пользователя
          </Button>
        </Stack>
      </Paper>

      <TableContainer component={Paper} className="table-surface">
        <Table size="small" sx={{ minWidth: 1200 }}>
          <TableHead>
            <TableRow>
              <TableCell>Действия</TableCell>
              <TableCell>Логин</TableCell>
              <TableCell>Роль</TableCell>
              <TableCell>Фамилия</TableCell>
              <TableCell>Имя</TableCell>
              <TableCell>Отчество</TableCell>
              <TableCell>Телефон</TableCell>
              <TableCell>Email</TableCell>
              <TableCell>Max</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {filteredUsers.map((user) => (
              <TableRow
                key={user.id}
                hover
                onClick={() => setEditingUser(user)}
                sx={{ cursor: 'pointer' }}
              >
                <TableCell sx={{ minWidth: 80 }}>
                  <IconButton
                    onClick={(event) => {
                      event.stopPropagation();
                      setDeleteTarget(user);
                    }}
                    aria-label="Удалить пользователя"
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </TableCell>
                <TableCell sx={{ minWidth: 160 }}>{user.login}</TableCell>
                <TableCell sx={{ minWidth: 160 }}>{roleLabels[user.role]}</TableCell>
                <TableCell sx={{ minWidth: 150 }}>{user.profile?.last_name || '—'}</TableCell>
                <TableCell sx={{ minWidth: 150 }}>{user.profile?.name || '—'}</TableCell>
                <TableCell sx={{ minWidth: 170 }}>{user.profile?.second_name || '—'}</TableCell>
                <TableCell sx={{ minWidth: 170 }}>{user.profile?.phone || '—'}</TableCell>
                <TableCell sx={{ minWidth: 220 }}>{user.profile?.email || '—'}</TableCell>
                <TableCell sx={{ minWidth: 240 }}>{user.profile?.max_link || '—'}</TableCell>
              </TableRow>
            ))}
            {filteredUsers.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} align="center">Пользователи не найдены</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      <CreateUserDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onCreated={refresh} />
      <EditUserDialog user={editingUser} onClose={() => setEditingUser(null)} onSaved={refresh} />

      <ConfirmDialog
        open={!!deleteTarget}
        title="Удалить пользователя?"
        description={`Пользователь «${deleteTarget?.login || ''}» будет удалён из системы. Это действие нельзя отменить.`}
        pending={deleteUser.isPending}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          deleteUser.mutate(deleteTarget.id);
        }}
      />
    </Stack>
  );
}
