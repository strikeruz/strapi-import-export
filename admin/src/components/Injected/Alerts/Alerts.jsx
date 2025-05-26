import './style.css';

import { Alert, Portal } from '@strapi/design-system';
import styled from 'styled-components'; // Correct import for styled
import React from 'react';

import { useAlerts } from '../../../hooks/useAlerts';

const AlertWrapper = styled.div`
  position: fixed;
  top: 0;
  left: 50%;
  transform: translate(-50%, 0);
  z-index: 10000;
  padding: 16px;

  & > *:not(:first-child) {
    margin-top: 16px;
  }
`;

export const Alerts = () => {
  const { alerts, removeAlert } = useAlerts();

  return (
    <Portal>
      <AlertWrapper>
        {alerts?.map(({ id, title, message, variant }) => (
          <Alert
            key={id}
            closeLabel="Close"
            title={title}
            variant={variant}
            onClose={() => removeAlert(id)}
          >
            {message}
          </Alert>
        ))}
      </AlertWrapper>
    </Portal>
  );
};
