import { memo, useEffect, useState } from '../../lib/teact/teact';

import type { IconName } from '../../types/icons';
import type { CorpEmployeeInfo } from '../api';

import { updateCorpMe } from '../api';
import { corpEngine } from '../engine';
import { getEmployeeId, isCorpMentionKeywordId, isCorpUserId } from '../ids';
import {
  getCorpProfiles, getMyProfileOpen, setMyProfileOpen, updateCorpProfile,
} from '../profile';

import useDerivedState from '../../hooks/useDerivedState';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../../components/ui/Button';
import InputText from '../../components/ui/InputText';
import ListItem from '../../components/ui/ListItem';
import Modal from '../../components/ui/Modal';

import styles from './CorpPanels.module.scss';

// ISO weekdays: 1 = Monday
const WEEKDAYS = ['', 'Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'];
const MAX_PHONE_LENGTH = 32;

type FieldKey = 'TeleTwinProfileTitle' | 'TeleTwinProfileDepartment' | 'TeleTwinProfilePhone'
  | 'TeleTwinProfileBirthday' | 'TeleTwinProfileWorkHours';

function formatWorkHours(workHours: CorpEmployeeInfo['workHours']) {
  if (!workHours || typeof workHours !== 'object') return undefined;
  const days = Array.isArray(workHours.days) ? workHours.days.map((day) => WEEKDAYS[day]).filter(Boolean) : [];
  const time = workHours.from && workHours.to ? `${workHours.from}–${workHours.to}` : '';
  const text = [days.join(', '), time].filter(Boolean).join(' · ');
  return text || undefined;
}

function formatBirthday(birthday?: string | null) {
  if (!birthday) return undefined;
  const date = new Date(`${birthday}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? birthday : date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

function buildFields(employee: CorpEmployeeInfo): { key: FieldKey; icon: IconName; value?: string }[] {
  return [
    { key: 'TeleTwinProfileTitle', icon: 'info', value: employee.title || undefined },
    { key: 'TeleTwinProfileDepartment', icon: 'group', value: employee.department || undefined },
    { key: 'TeleTwinProfilePhone', icon: 'phone', value: employee.phone || undefined },
    { key: 'TeleTwinProfileBirthday', icon: 'calendar', value: formatBirthday(employee.birthday) },
    { key: 'TeleTwinProfileWorkHours', icon: 'schedule', value: formatWorkHours(employee.workHours) },
  ];
}

const FieldList = ({ employee }: { employee: CorpEmployeeInfo }) => {
  const lang = useLang();
  const fields = buildFields(employee).filter(({ value }) => value);
  if (!fields.length) return undefined;

  return (
    <div className={styles.fields} data-corp-profile-fields>
      {fields.map(({ key, icon, value }) => (
        <ListItem key={key} icon={icon} multiline isStatic>
          <span className="title" dir="auto">{value}</span>
          <span className="subtitle">{lang(key)}</span>
        </ListItem>
      ))}
    </div>
  );
};

// Profile panel of a corp employee: the server profile fields under the stock header
export const CorpProfileFields = ({ peerId }: { peerId?: string }) => {
  const profiles = useDerivedState(getCorpProfiles);
  if (!peerId || !isCorpUserId(peerId) || isCorpMentionKeywordId(peerId)) return undefined;
  const employee = profiles[getEmployeeId(peerId)];

  return employee ? <FieldList employee={employee} /> : undefined;
};

// "Profilim": own profile fields; employees may change only their phone, the rest is set by an admin
const CorpMyProfileModalComponent = () => {
  const lang = useLang();
  const isOpen = useDerivedState(getMyProfileOpen);
  const profiles = useDerivedState(getCorpProfiles);
  const ownId = corpEngine.credentials?.employee.id;
  const employee = ownId ? profiles[ownId] : undefined;
  const [phone, setPhone] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (isOpen) setPhone(employee?.phone || '');
  }, [isOpen, employee?.phone]);

  const handleClose = useLastCallback(() => setMyProfileOpen(false));
  const handleSave = useLastCallback(async () => {
    const credentials = corpEngine.credentials;
    if (!credentials) return;
    setIsSaving(true);
    try {
      const result = await updateCorpMe(credentials.server, credentials.token, { phone: phone.trim() });
      updateCorpProfile({ ...result, id: result.id || credentials.employee.id });
      handleClose();
    } catch (err) {
      corpEngine.handleFailure(err);
    } finally {
      setIsSaving(false);
    }
  });

  const readOnly = employee ? { ...employee, phone: undefined } : undefined;

  return (
    <Modal isOpen={isOpen} title={lang('TeleTwinMyProfile')} hasCloseButton onClose={handleClose}>
      <div data-corp-my-profile>
        {employee && <div className={styles.caption}>{`${employee.fullName} (@${employee.login})`}</div>}
        {readOnly && <FieldList employee={readOnly} />}
        <InputText
          id="teletwin-profile-phone"
          label={lang('TeleTwinProfilePhone')}
          value={phone}
          maxLength={MAX_PHONE_LENGTH}
          inputMode="tel"
          onChange={(e) => setPhone(e.currentTarget.value)}
        />
        <div className={styles.hint}>{lang('TeleTwinMyProfileHint')}</div>
        <Button
          onClick={() => void handleSave()}
          isLoading={isSaving}
          disabled={phone.trim() === (employee?.phone || '')}
        >
          {lang('TeleTwinStatusSave')}
        </Button>
      </div>
    </Modal>
  );
};

export const CorpMyProfileModal = memo(CorpMyProfileModalComponent);
