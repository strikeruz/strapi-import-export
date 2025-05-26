import React from 'react';
import {
  Modal,
  Button,
  Typography,
  Flex,
  Grid,
  Loader,
  SingleSelect,
  SingleSelectOption,
  Checkbox,
} from '@strapi/design-system';
import { Download } from '@strapi/icons';

import { useI18n } from '../../hooks/useI18n';
import { ExportModalContent, useExportModal, ExportModalFooter } from '../ExportModal/ExportModal';

export const InjectedExportCollectionType = () => {
  const state = useExportModal({ unavailableOptions: ['exportPluginsContentTypes'] });

  const { i18n } = useI18n();

  return (
    <Modal.Root onOpenChange={state.handleOpenChange}>
      <Modal.Trigger>
        <Button startIcon={<Download />}>{i18n('plugin.cta.export', 'Export')}</Button>
      </Modal.Trigger>
      {state.isOpen && (
        <Modal.Content>
          <Modal.Header>
            <Modal.Title>
              <Flex gap={2}>
                <Typography fontWeight="bold" textColor="neutral800" tag="h2" id="title">
                  {i18n('plugin.cta.export', 'Export')}
                </Typography>
                <Typography textColor="neutral800" tag="h2" id="title">
                  {state.isSlugWholeDb
                    ? i18n('plugin.export.whole-database', 'Whole database')
                    : state.slug}
                </Typography>
              </Flex>
            </Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <ExportModalContent state={state} />
          </Modal.Body>
          <Modal.Footer>
            <ExportModalFooter state={state} />
          </Modal.Footer>
        </Modal.Content>
      )}
    </Modal.Root>
  );

  //   return <ExportModal unavailableOptions={['exportPluginsContentTypes']} />;
};
