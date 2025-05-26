import { Download } from '@strapi/icons';
import { useQueryParams } from '@strapi/admin/strapi-admin';
import { Modal } from '@strapi/design-system';

import React from 'react';
import { useI18n } from '../../hooks/useI18n';
import { buildValidParams } from '@strapi/content-manager/strapi-admin';

import type { BulkActionComponent } from '@strapi/content-manager/strapi-admin';
import { ExportModalContent, ExportModalFooter, useExportModal } from '../ExportModal/ExportModal';

const ExportAction: BulkActionComponent = ({ documents, model, collectionType }) => {
  const { i18n } = useI18n();
  const [{ query }] = useQueryParams<{ plugins?: { i18n?: { locale?: string } } }>();
  const params = React.useMemo(() => buildValidParams(query), [query]);
  const documentIds = documents.map(({ documentId }) => documentId);

  const state = useExportModal({ unavailableOptions: ['exportPluginsContentTypes'], documentIds });

  return {
    variant: 'default',
    label: i18n('plugin.cta.export', 'Export'),
    icon: <Download />,
    onClick: () => {
      state.resetOptions();
      console.log('onClick');
      console.log('collectionType', collectionType);
      console.log('model', model);
      console.log('documents', documents);
      console.log('documentIds', documentIds);
    },
    dialog: {
      type: 'modal',
      title: i18n('plugin.cta.export', 'Export'),
      content: <ExportModalContent state={state} />,
      footer: (
        <Modal.Footer>
          <ExportModalFooter state={state} />
        </Modal.Footer>
      ),
    },
  };
};

const BULK_ACTIONS: BulkActionComponent[] = [ExportAction];

export { BULK_ACTIONS };
