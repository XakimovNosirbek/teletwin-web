import { memo, useEffect, useMemo, useState } from '../../lib/teact/teact';

import type { CorpEmployeeInfo } from '../api';

import { fetchCorpEmployees } from '../api';
import {
  getCorpCredentials, getDirectPickerOpen, openDirectChatWith, setDirectPickerOpen,
} from '../index';

import useDerivedState from '../../hooks/useDerivedState';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import InputText from '../../components/ui/InputText';
import ListItem from '../../components/ui/ListItem';
import Modal from '../../components/ui/Modal';

// "Xodimga yozish": picks an employee and opens the direct chat with them
const CorpDirectPicker = () => {
  const lang = useLang();
  const isOpen = useDerivedState(getDirectPickerOpen);
  const credentials = useDerivedState(getCorpCredentials);
  const [employees, setEmployees] = useState<CorpEmployeeInfo[] | undefined>();
  const [query, setQuery] = useState('');

  useEffect(() => {
    setEmployees(undefined);
    setQuery('');
    if (!isOpen || !credentials) return undefined;
    let isActual = true;
    fetchCorpEmployees(credentials.server, credentials.token).then((list) => {
      if (isActual) setEmployees(list.filter(({ id }) => id !== credentials.employee.id));
    }, () => {
      if (isActual) setEmployees([]);
    });

    return () => {
      isActual = false;
    };
  }, [isOpen, credentials]);

  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return employees;

    return employees?.filter(({ fullName, login }) => (
      fullName.toLowerCase().includes(search) || login.toLowerCase().includes(search)
    ));
  }, [employees, query]);

  const handleClose = useLastCallback(() => {
    setDirectPickerOpen(false);
  });

  const handleQueryChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
  });

  const handleSelect = useLastCallback((employee: CorpEmployeeInfo) => {
    handleClose();
    void openDirectChatWith(employee.id);
  });

  return (
    <Modal
      isOpen={Boolean(isOpen && credentials)}
      title={lang('TeleTwinDirectPickTitle')}
      hasCloseButton
      onClose={handleClose}
    >
      <InputText value={query} label={lang('Search')} onChange={handleQueryChange} />
      {filtered?.map((employee) => (
        <ListItem key={employee.id} icon="user" onClick={() => handleSelect(employee)}>
          {`${employee.fullName} (@${employee.login})`}
        </ListItem>
      ))}
    </Modal>
  );
};

export default memo(CorpDirectPicker);
