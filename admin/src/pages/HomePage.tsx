//@ts-nocheck
import {
  Box,
  Checkbox,
  Flex,
  Link,
  Option,
  Select,
  Typography,
  Modal,
  Button,
} from '@strapi/design-system';
import { Download } from '@strapi/icons';

import React, { memo, useState } from 'react';
import { Page } from '@strapi/strapi/admin';
import { pluginPermissions } from '../permissions';
import { Main } from '@strapi/design-system';
import { useIntl } from 'react-intl';
import { Header } from '../components/Header';
import { ImportModal } from '../components/ImportModal/ImportModal';
import {
  ExportModalContent,
  useExportModal,
  ExportModalFooter,
} from '../components/ExportModal/ExportModal';
import Preferences from '../components/Preferences/Preferences';
import About from '../components/About/About';
import { getTranslation } from '../utils/getTranslation';
import { useI18n } from '../hooks/useI18n';
import { dataFormats } from '../utils/dataFormats';

const HomePage = () => {
  const { formatMessage } = useIntl();
  const { i18n } = useI18n();

  const state = useExportModal({ unavailableOptions: ['exportPluginsContentTypes'] });

  return (
    <>
      {/* mango */}
      <Main>
        <Box padding={6} paddingTop={3}>
          <Header />
          <Page.Protect permissions={pluginPermissions.main}>
            <Box
              style={{ alignSelf: 'stretch' }}
              background="neutral0"
              padding={8}
              margin={6}
              hasRadius={true}
            >
              <Flex direction="column" alignItems="start" gap={6}>
                <Flex direction="column" alignItems="start" gap={0}>
                  <Typography variant="alpha">
                    {i18n('plugin.page.homepage.section.quick-actions.title', 'Global Actions')}
                  </Typography>
                  <Typography variant="epsilon">
                    {i18n(
                      'plugin.page.homepage.section.quick-actions.description',
                      'Import and export data from all your content types at once.'
                    )}
                  </Typography>
                </Flex>
                <Box>
                  <Flex direction="column" alignItems="start" gap={4}>
                    <Flex gap={4}>
                      <ImportModal />
                      <Modal.Root onOpenChange={state.handleOpenChange}>
                        <Modal.Trigger>
                          <Button startIcon={<Download />}>
                            {i18n('plugin.cta.export', 'Export')}
                          </Button>
                        </Modal.Trigger>
                        {state.isOpen && (
                          <Modal.Content>
                            <Modal.Header>
                              <Modal.Title>
                                <Flex gap={2}>
                                  <Typography
                                    fontWeight="bold"
                                    textColor="neutral800"
                                    tag="h2"
                                    id="title"
                                  >
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
                    </Flex>
                  </Flex>
                </Box>
              </Flex>
            </Box>
            <Box padding={6} paddingTop={3} paddingBottom={0}>
              <Preferences />
            </Box>
            <Box padding={6} paddingTop={3} paddingBottom={0}>
              <About />
            </Box>
          </Page.Protect>
        </Box>
      </Main>
    </>
  );
};

export default memo(HomePage);
