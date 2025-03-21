import { Modal, Button, Typography, Flex, Box, Loader, Accordion, Tabs } from '@strapi/design-system';
import { CheckCircle, Code as IconCode, File as IconFile, Upload, CrossCircle, WarningCircle } from '@strapi/icons';

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIntl } from 'react-intl';
import styled from 'styled-components'; // Correct import for styled
import { useFetchClient } from '@strapi/admin/strapi-admin';
import {PLUGIN_ID} from '../../pluginId'
// Styled components
const Label = styled.label`
  --hover-color: hsl(210, 100%, 50%);
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: start;
  flex: 1;
  height: 260px;
  padding: 48px;
  border-width: 3px;
  border-color: #ddd;
  border-radius: 12px;
  cursor: pointer;
  border-style: dashed;
  text-align: center;
  &:hover {
    border-color: var(--hover-color);
  }

  & > *:not(:first-child) {
    margin-top: 16px;
  }

  input {
    display: none;
  }
`;

const IconWrapper = styled.span`
  height: 100px;
  svg {
    width: 6rem;
    height: 6rem;
    color: #C0C0CF;
  }
    display: flex;
    flex-direction: column;
    justify-content: center;
`;

const DragOverLabel = styled(Label)`
  &.dragged-over {
    border-color: var(--hover-color);

    &::after {
      content: "";
      display: block;
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      left: 0;
      z-index: 5;
    }
  }
`;

import { useAlerts } from '../../hooks/useAlerts';
import { useI18n } from '../../hooks/useI18n';
import { useSlug } from '../../hooks/useSlug';
import { dataFormats } from '../../utils/dataFormats';
import { handleRequestErr } from '../../utils/error';
import getTrad from '../../utils/getTrad';

import { Editor } from '../Editor/Editor';
import { ImportEditor } from './components/ImportEditor/ImportEditor';

const ModalState = {
  SUCCESS: 'success',
  PARTIAL: 'partial',
  ERROR: 'error',
  UNSET: 'unset',
};

export const ImportModal = ({ onClose }) => {
  const { i18n } = useI18n();
  const { formatMessage } = useIntl();

  const { slug } = useSlug();
  const { notify } = useAlerts();
  const navigate = useNavigate();

  const [file, setFile] = useState({});
  const [data, setData] = useState('');
  const [options, setOptions] = useState({});
  const [dataFormat, setDataFormat] = useState(dataFormats.CSV);
  const [labelClassNames, setLabelClassNames] = useState('plugin-ie-import_modal_input-label');
  const [uploadSuccessful, setUploadSuccessful] = useState(ModalState.UNSET);
  const [uploadingData, setUploadingData] = useState(false);
  const [importFailuresContent, setImportFailuresContent] = useState('');
  const [importErrorsContent, setImportErrorsContent] = useState('');
  const [parsedData, setParsedData] = useState(null);

  const handleDataChanged = (newData) => {
    try {
      const parsed = JSON.parse(newData);
      setParsedData(parsed);
      setData(newData);
    } catch (e) {
      setParsedData(null);
      setData(newData);
    }
  };

  const onOptionsChanged = (options) => {
    console.log('onOptionsChanged', options);
    setOptions(options);
  };

  const onReadFile = (e) => {
    const file = e.target.files[0];
    readFile(file);
    setFile(file);
  };

  const readFile = (file) => {
    if (file.type === 'text/csv' || /\.csv$/i.test(file.name)) {
      setDataFormat(dataFormats.CSV);
    } else if (file.type === 'application/json' || /\.json$/i.test(file.name)) {
      setDataFormat(dataFormats.JSON);
    } else {
      throw new Error(`File type ${file.type} not supported.`);
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
      const text = e.target.result;
      setData(text);
    };
    reader.readAsText(file);
  };

  const openCodeEditor = () => {
    setData('{\n\t\n}');
    setDataFormat(dataFormats.JSON);
  };

  const resetDataSource = () => {
    setData('');
    setDataFormat(dataFormats.CSV);
    setUploadSuccessful(ModalState.UNSET);
    setFile({});
  };

  const fetchClient = useFetchClient(); // Use the hook here within the component

  const uploadData = async () => {
    setUploadingData(true);
    try {
      const { post } = fetchClient;
      const res = await post(`/${PLUGIN_ID}/import`, {
        // body: JSON.stringify({ slug, data, format: dataFormat, ...options }),
        data:{ slug, data, format: dataFormat, ...options },
        // headers: {
        //   'Content-Type': 'application/json',
        // },
      });

      const { failures, errors } = res.data;
      console.log('res', JSON.stringify(res, null, 2));
      if (!failures?.length && !errors?.length) {
        setUploadSuccessful(ModalState.SUCCESS);
        notify(
          i18n('plugin.message.import.success.imported.title'),
          i18n('plugin.message.import.success.imported.message'),
          'success'
        );
        refreshView();
      }
      else if (failures?.length) {
        setUploadSuccessful(ModalState.PARTIAL);
        setImportFailuresContent(JSON.stringify(failures, null, '\t'));
        notify(
          i18n('plugin.message.import.error.imported-partial.title'),
          i18n('plugin.message.import.error.imported-partial.message'),
          'danger'
        );
      }
      else if (errors?.length) {
        setUploadSuccessful(ModalState.ERROR);
        setImportErrorsContent(JSON.stringify(errors, null, '\t'));
      }
    } catch (err) {
      console.log('err', err);
      handleRequestErr(err, {
        403: () =>
          notify(
            i18n('plugin.message.import.error.forbidden.title'),
            i18n('plugin.message.import.error.forbidden.message'),
            'danger'
          ),
        413: () =>
          notify(
            i18n('plugin.message.import.error.payload-too-large.title'),
            i18n('plugin.message.import.error.payload-too-large.message'),
            'danger'
          ),
        default: () =>
          notify(
            i18n('plugin.message.import.error.unexpected.title'),
            i18n('plugin.message.import.error.unexpected.message'),
            'danger'
          ),
      });
    } finally {
      setUploadingData(false);
    }
  };

  const refreshView = () => {
    navigate('/tmp');
    navigate(-1);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setLabelClassNames(
      [labelClassNames, 'plugin-ie-import_modal_input-label--dragged-over'].join(' ')
    );
  };

  const handleDragLeave = () => {
    setLabelClassNames(
      labelClassNames.replaceAll('plugin-ie-import_modal_input-label--dragged-over', '')
    );
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleDragLeave();
    const file = e.dataTransfer.files[0];
    readFile(file);
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(data);
    notify('Copied', '', 'success');
  };

  const showLoader = uploadingData;
  const showFileDragAndDrop = !uploadingData && uploadSuccessful === ModalState.UNSET && !data;
  const showEditor = !uploadingData && uploadSuccessful === ModalState.UNSET && data;
  const showSuccess = !uploadingData && uploadSuccessful === ModalState.SUCCESS;
  const showPartialSuccess = !uploadingData && uploadSuccessful === ModalState.PARTIAL;
  const showError = !uploadingData && uploadSuccessful === ModalState.ERROR;

  const showImportButton = showEditor;
  const showRemoveFileButton = showEditor || showError || showPartialSuccess;

  return (
    <Modal.Root onClose={onClose}>
      <Modal.Trigger>
        <Button startIcon={<Upload />}>{formatMessage({ id: getTrad('plugin.cta.import') })}</Button>
      </Modal.Trigger>
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>
            <Typography fontWeight="bold" textColor="neutral800" as="h2" style={{ marginBottom: '16px' }}>
              {i18n('plugin.cta.import')}
            </Typography>
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {showFileDragAndDrop && (
            <>
            <div style={{ marginBottom: '24px' }}>
              <Typography variant="beta" textColor="neutral800">
                {i18n('plugin.import.data-source-step.title')}
              </Typography>
            </div>
              <Flex gap={4}>
                <DragOverLabel
                  className={`plugin-ie-import_modal_label ${labelClassNames}`}
                  onDragEnter={handleDragEnter}
                  onDragLeave={handleDragLeave}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                >
                  <IconWrapper>
                    <IconFile />
                  </IconWrapper>
                  <Typography variant="delta" textColor="neutral600">
                    {i18n('plugin.import.drag-drop-file')}
                  </Typography>
                  <input type="file" accept=".csv,.json" hidden="" onChange={onReadFile} />
                </DragOverLabel>
                <Label className="plugin-ie-import_modal_button-label" onClick={openCodeEditor}>
                  <IconWrapper>
                    <IconCode />
                  </IconWrapper>
                  <Typography variant="delta" textColor="neutral600">
                    {i18n('plugin.import.use-code-editor')}
                  </Typography>
                </Label>
              </Flex>
            </>
          )}
          {showLoader && (
            <>
              <Flex justifyContent="center">
                <Loader>{i18n('plugin.import.importing-data')}</Loader>
              </Flex>
            </>
          )}
          {showEditor && <ImportEditor 
            file={file}
            data={data}
            dataFormat={dataFormat}
            slug={slug}
            onDataChanged={handleDataChanged}
            onOptionsChanged={setOptions}
            version={parsedData?.version}
          />}
          {showSuccess && (
            <Flex direction="column" alignItems="center" gap={4}>
              <Box paddingBottom={4}>
                <CheckCircle width="6rem" height="6rem" color="success500" />
              </Box>
              <Typography variant="beta" textColor="neutral800">
                {i18n('plugin.message.import.success.imported-successfully')}
              </Typography>
              <Box paddingTop={4}>
                <Button onClick={onClose} variant="tertiary">
                  {i18n('plugin.cta.close')}
                </Button>
              </Box>
            </Flex>
          )}
          {showPartialSuccess && (
            <>
              <Typography textColor="neutral800" fontWeight="bold" as="h2">
                {i18n('plugin.import.partially-failed')}
              </Typography>
              <Typography textColor="neutral800" as="p">
                {i18n('plugin.import.detailed-information')}
              </Typography>
              <Editor content={importFailuresContent} language={'json'} readOnly />
            </>
          )}
          {showError && (
            <>
              <Tabs.Root defaultValue="errors">
                <Tabs.List>
                  <Tabs.Trigger value="errors">Errors List</Tabs.Trigger>
                  <Tabs.Trigger value="output">Errors Details</Tabs.Trigger>
                </Tabs.List>
                <Tabs.Content value="errors">
                  <Typography textColor="neutral800" fontWeight="bold" as="h2">
                    {i18n('plugin.import.errors')}
                  </Typography>
                  <Accordion.Root size="M">
                    {JSON.parse(importErrorsContent).map((error, index) => (
                      <Accordion.Item key={index} value={`acc-${index}`}>
                        <Accordion.Header>
                          <Accordion.Trigger icon={CrossCircle} description={error.data?.path || ''}>
                            {error.error}
                          </Accordion.Trigger>
                        </Accordion.Header>
                        <Accordion.Content>
                          <Typography display="block" tag='pre' padding={4}>
                            {typeof error.data?.entry === 'string' ? error.data?.entry : JSON.stringify(error.data?.entry || '', null, 2)}
                          </Typography>
                        </Accordion.Content>
                      </Accordion.Item>
                    ))}
                  </Accordion.Root>
                </Tabs.Content>
                <Tabs.Content value="output">
                  <Editor content={importErrorsContent} language={'json'} readOnly />
                </Tabs.Content>
              </Tabs.Root>
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          {showRemoveFileButton && (
            <Button onClick={resetDataSource} variant="tertiary">
              {i18n('plugin.cta.back-to-data-sources')}
            </Button>
          )}
          {showImportButton && <Button onClick={uploadData}>{i18n('plugin.cta.import')}</Button>}
          {showPartialSuccess && (
            <Button variant="secondary" onClick={copyToClipboard}>
              {i18n('plugin.cta.copy-to-clipboard')}
            </Button>
          )}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
};