import { memo, useEffect, useState } from '../../lib/teact/teact';
import { getGlobal } from '../../global';

import type { ApiMessage } from '../../api/types';
import type { CorpMember } from '../api';

import { fetchCorpMembers } from '../api';
import {
  getEmployeeId, getServerChatId, isCorpChatId, isCorpUserId,
} from '../ids';
import { getCorpCredentials, wakeUpEmployee } from '../index';
import { getWakeUpPickerChatId, setWakeUpPickerChatId } from '../wakeup';

import useDerivedState from '../../hooks/useDerivedState';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import ListItem from '../../components/ui/ListItem';
import MenuItem from '../../components/ui/MenuItem';
import Modal from '../../components/ui/Modal';

// Message context menu: wakes up the sender of a corp message from someone else
export const CorpWakeUpMessageItem = ({ message, onClose }: { message: ApiMessage; onClose: NoneToVoidFunction }) => {
  const lang = useLang();
  const { chatId, senderId } = message;

  const handleClick = useLastCallback(() => {
    onClose();
    const sender = getSenderName(senderId!);
    void wakeUpEmployee(getEmployeeId(senderId!), getServerChatId(chatId), sender);
  });

  if (!isCorpChatId(chatId) || message.isOutgoing || !isCorpUserId(senderId)) return undefined;

  return (
    <MenuItem icon="unmute" onClick={handleClick}>{lang('TeleTwinWakeUp')}</MenuItem>
  );
};

// Chat header menu: picks a member of the corp chat to wake up
export const CorpWakeUpHeaderItem = ({ chatId, onClose }: { chatId: string; onClose: NoneToVoidFunction }) => {
  const lang = useLang();

  const handleClick = useLastCallback(() => {
    onClose();
    setWakeUpPickerChatId(chatId);
  });

  if (!isCorpChatId(chatId)) return undefined;

  return (
    <MenuItem icon="unmute" onClick={handleClick}>{lang('TeleTwinWakeUpPick')}</MenuItem>
  );
};

const CorpWakeUpPickerComponent = () => {
  const lang = useLang();
  const chatId = useDerivedState(getWakeUpPickerChatId);
  const credentials = useDerivedState(getCorpCredentials);
  const [members, setMembers] = useState<CorpMember[] | undefined>();

  useEffect(() => {
    setMembers(undefined);
    if (!chatId || !credentials) return;
    let isActual = true;
    fetchCorpMembers(credentials.server, credentials.token, getServerChatId(chatId)).then((list) => {
      if (isActual) setMembers(list.filter(({ id }) => id !== credentials.employee.id));
    }, () => {
      if (isActual) setMembers([]);
    });

    return () => {
      isActual = false;
    };
  }, [chatId, credentials]);

  const handleClose = useLastCallback(() => {
    setWakeUpPickerChatId(undefined);
  });

  const handleSelect = useLastCallback((member: CorpMember) => {
    handleClose();
    void wakeUpEmployee(member.id, getServerChatId(chatId!), member.fullName);
  });

  return (
    <Modal
      isOpen={Boolean(chatId && credentials)}
      title={lang('TeleTwinWakeUpPickTitle')}
      hasCloseButton
      onClose={handleClose}
    >
      {members?.map((member) => (
        <ListItem key={member.id} icon="user" onClick={() => handleSelect(member)}>
          {member.fullName}
        </ListItem>
      ))}
    </Modal>
  );
};

export const CorpWakeUpPicker = memo(CorpWakeUpPickerComponent);

function getSenderName(senderId: string) {
  const user = getGlobal().users.byId[senderId];
  return user ? [user.firstName, user.lastName].filter(Boolean).join(' ') : '';
}
