import {
  Modal,
  Button,
  Typography,
  Flex,
  Box,
  Loader,
  Accordion,
  Tabs,
} from '@strapi/design-system';
import {
  CheckCircle,
  Code as IconCode,
  File as IconFile,
  Upload,
  CrossCircle,
  WarningCircle,
} from '@strapi/icons';

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIntl } from 'react-intl';
import styled from 'styled-components'; // Correct import for styled
import { useFetchClient } from '@strapi/admin/strapi-admin';
import { PLUGIN_ID } from '../../pluginId';
// import { EventSourcePolyfill } from 'event-source-polyfill';  // Alternative import for EventSource
import { EventSource } from 'eventsource';

import { adminApi } from '@strapi/admin/strapi-admin';
import { useDispatch } from 'react-redux';
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
    color: #c0c0cf;
  }
  display: flex;
  flex-direction: column;
  justify-content: center;
`;

const DragOverLabel = styled(Label)`
  &.dragged-over {
    border-color: var(--hover-color);

    &::after {
      content: '';
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
  const [importProgress, setImportProgress] = useState(0);
  const [importStatus, setImportStatus] = useState('idle');
  const [importMessage, setImportMessage] = useState('');
  const [sseConnection, setSseConnection] = useState(null);

  const dispatch = useDispatch();

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

  // Ha, Strapi only stores the token in localStorage when you check "Remember me" in the login form.
  // It looks like it uses sessionStorage when you are running in dev mode instead of using cookies.
  // Or maybe it has something to do with local IPs.
  // But I still don't know why it isn't reading from the cookies in production, so I am reimplementing the function here.
  // Unfortunately, in all my testing, I can NOT read cookies from the browser in production. I don't know why.
  const getCookieValue = (name) => {
    let result = null;
    const cookieArray = document.cookie.split(';');
    cookieArray.forEach((cookie) => {
      console.log('cookie', cookie);
      const [key, value] = cookie.split('=').map((item) => item.trim());
      if (key === name) {
        result = decodeURIComponent(value);
      }
    });
    return result;
  };

  const getToken = () => {
    const fromLocalStorage = localStorage.getItem('jwtToken');
    if (fromLocalStorage) {
      return JSON.parse(fromLocalStorage);
    }
    const fromSessionStorage = sessionStorage.getItem('jwtToken');
    if (fromSessionStorage) {
      return JSON.parse(fromSessionStorage);
    }

    const fromCookie = getCookieValue('jwtToken');
    return fromCookie ?? null;
  };

  const fetchClient = useFetchClient(); // Use the hook here within the component

  const connectToSSE = () => {
    // const token = JSON.parse(
    //   localStorage.getItem('jwtToken') ?? sessionStorage.getItem('jwtToken') ?? '""'
    // );

    const backendURL = window.strapi.backendURL;

    const addPrependingSlash = (url) => (url.charAt(0) !== '/' ? `/${url}` : url);

    // This regular expression matches a string that starts with either "http://" or "https://" or any other protocol name in lower case letters, followed by "://" and ends with anything else
    const hasProtocol = (url) => new RegExp('^(?:[a-z+]+:)?//', 'i').test(url);

    // Check if the url has a prepending slash, if not add a slash
    const normalizeUrl = (url) => (hasProtocol(url) ? url : addPrependingSlash(url));

    const addBaseUrl = (url) => {
      return `${backendURL}${url}`;
    };

    const url = normalizeUrl(`/${PLUGIN_ID}/import/progress`);
    const fullUrl = addBaseUrl(url);

    // Close any existing connection
    if (sseConnection) {
      console.log('Closing existing SSE connection');
      sseConnection.close();
    }

    // Create an EventSource with headers
    const eventSource = new EventSource(fullUrl, {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...init.headers,
            Authorization: `Bearer ${getToken()}`,
          },
        }),
    });

    eventSource.addEventListener('connected', (e) => {
      console.log('SSE connected:', e.data);
    });

    eventSource.addEventListener('status', (e) => {
      const data = JSON.parse(e.data);
      setImportStatus(data.status);
      setImportMessage(data.message || '');
      if (data.progress !== undefined) {
        setImportProgress(data.progress);
      }

      // Keep the uploading state active while we're processing
      if (data.status === 'processing' || data.status === 'validating') {
        setUploadingData(true);
      }
    });

    eventSource.addEventListener('complete', (e) => {
      const result = JSON.parse(e.data);
      setUploadingData(false);

      if (!result.failures?.length && !result.errors?.length) {
        setUploadSuccessful(ModalState.SUCCESS);
        notify(
          i18n('plugin.message.import.success.imported.title'),
          i18n('plugin.message.import.success.imported.message'),
          'success'
        );
        refreshView();
      } else if (result.failures?.length) {
        setUploadSuccessful(ModalState.PARTIAL);
        setImportFailuresContent(JSON.stringify(result.failures, null, '\t'));
        notify(
          i18n('plugin.message.import.error.imported-partial.title'),
          i18n('plugin.message.import.error.imported-partial.message'),
          'danger'
        );
      } else if (result.errors?.length) {
        setUploadSuccessful(ModalState.ERROR);
        setImportErrorsContent(JSON.stringify(result.errors, null, '\t'));
      }
    });

    eventSource.addEventListener('error', (e) => {
      try {
        const data = JSON.parse(e.data);
        console.error('Import error:', data);
        setUploadingData(false);
        setUploadSuccessful(ModalState.ERROR);
        setImportErrorsContent(
          JSON.stringify(
            [
              {
                error: data.message,
                data: { entry: {}, path: '' },
              },
            ],
            null,
            '\t'
          )
        );
      } catch (err) {
        // If e.data isn't valid JSON, it's a connection error
        console.error('SSE error event (not JSON):', e);
      }
    });

    eventSource.addEventListener('close', () => {
      eventSource.close();
      setSseConnection(null);
    });

    eventSource.onerror = (e) => {
      console.error('SSE connection error:', e);
      if (importStatus === 'processing' || importStatus === 'validating') {
        // Only show an error if we were in the middle of processing
        setUploadingData(false);
        setUploadSuccessful(ModalState.ERROR);
        setImportErrorsContent(
          JSON.stringify(
            [
              {
                error: 'SSE connection error',
                data: { entry: {}, path: '' },
              },
            ],
            null,
            '\t'
          )
        );
      }

      eventSource.close();
      setSseConnection(null);
    };

    setSseConnection(eventSource);
  };

  const uploadData = async () => {
    // For some reason, strapi isn't sending the token in the headers, so we need to add it manually
    setUploadingData(true);
    try {
      const { post } = fetchClient;
      const res = await post(
        `/${PLUGIN_ID}/import`,
        {
          data: { slug, data, format: dataFormat, ...options },
        },
        { headers: { Authorization: `Bearer ${getToken()}` } }
      );

      if (res.data.status === 'error') {
        // Handle error response
        notify(i18n('plugin.message.import.error.unexpected.title'), res.data.message, 'danger');
        setUploadingData(false);
        return;
      }

      if (res.data.status === 'started' && res.data.useSSE) {
        // This is a background job using SSE
        console.log('Should connect to SSE');
        connectToSSE();
        return;
      }

      // Handle normal/synchronous response
      const { failures, errors } = res.data;

      if (!failures?.length && !errors?.length) {
        setUploadSuccessful(ModalState.SUCCESS);
        notify(
          i18n('plugin.message.import.success.imported.title'),
          i18n('plugin.message.import.success.imported.message'),
          'success'
        );
        refreshView();
      } else if (failures?.length) {
        setUploadSuccessful(ModalState.PARTIAL);
        setImportFailuresContent(JSON.stringify(failures, null, '\t'));
        notify(
          i18n('plugin.message.import.error.imported-partial.title'),
          i18n('plugin.message.import.error.imported-partial.message'),
          'danger'
        );
      } else if (errors?.length) {
        setUploadSuccessful(ModalState.ERROR);
        setImportErrorsContent(JSON.stringify(errors, null, '\t'));
      }

      setUploadingData(false);
    } catch (err) {
      console.log('err', err);

      handleRequestErr(err, {
        403: () =>
          notify(
            i18n('plugin.message.import.error.forbidden.title'),
            i18n('plugin.message.import.error.forbidden.message'),
            'danger'
          ),
        409: () =>
          notify(
            'Import in progress',
            'Another import is already in progress. Please wait for it to complete.',
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
      setUploadingData(false);
    }
  };

  const refreshView = () => {
    dispatch(
      adminApi.util.invalidateTags([
        'Document',
        'HistoryVersion',
        'Relations',
        'UidAvailability',
        'RecentDocumentList',
      ])
    );
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

  // Clean up SSE connection when component unmounts
  useEffect(() => {
    return () => {
      if (sseConnection) {
        sseConnection.close();
      }
    };
  }, [sseConnection]);

  return (
    <Modal.Root onClose={onClose}>
      <Modal.Trigger>
        <Button startIcon={<Upload />}>
          {formatMessage({ id: getTrad('plugin.cta.import') })}
        </Button>
      </Modal.Trigger>
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>
            <Typography
              fontWeight="bold"
              textColor="neutral800"
              as="h2"
              style={{ marginBottom: '16px' }}
            >
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
              <Flex justifyContent="center" direction="column" alignItems="center" gap={4}>
                <Typography variant="beta">
                  {importMessage || i18n('plugin.import.importing-data')}
                </Typography>
                <Loader>{`${Math.round(importProgress)}%`}</Loader>
                <Box width="100%" padding={4}>
                  <div
                    style={{
                      width: '100%',
                      height: '8px',
                      backgroundColor: '#f0f0f0',
                      borderRadius: '4px',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${importProgress}%`,
                        height: '100%',
                        backgroundColor: '#4945ff',
                        borderRadius: '4px',
                        transition: 'width 0.3s ease-in-out',
                      }}
                    />
                  </div>
                </Box>
              </Flex>
            </>
          )}
          {showEditor && (
            <ImportEditor
              file={file}
              data={data}
              dataFormat={dataFormat}
              slug={slug}
              onDataChanged={handleDataChanged}
              onOptionsChanged={setOptions}
              version={parsedData?.version}
            />
          )}
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
                          <Accordion.Trigger
                            icon={CrossCircle}
                            description={error.data?.path || ''}
                          >
                            {error.error}
                          </Accordion.Trigger>
                        </Accordion.Header>
                        <Accordion.Content>
                          <Box padding={4}>
                            <Typography fontWeight="bold" marginBottom={2}>
                              Entry Value:
                            </Typography>
                            <Typography
                              display="block"
                              tag="pre"
                              marginBottom={3}
                              padding={2}
                              background="neutral100"
                            >
                              {typeof error.data?.entry === 'string'
                                ? error.data?.entry
                                : JSON.stringify(error.data?.entry || '', null, 2)}
                            </Typography>

                            {error.details && (
                              <>
                                <Typography fontWeight="bold" marginBottom={2}>
                                  Search Details:
                                </Typography>
                                <Box marginBottom={2}>
                                  {error.details.searchDetails && (
                                    <Box padding={2} background="neutral100" marginBottom={2}>
                                      <Typography variant="omega" fontWeight="semiBold">
                                        Search Information:
                                      </Typography>
                                      <Typography variant="pi">
                                        • Content Type: {error.details.searchDetails.contentType}
                                      </Typography>
                                      <Typography variant="pi">
                                        • Search Field: {error.details.searchDetails.searchField}
                                      </Typography>
                                      <Typography variant="pi">
                                        • Is Localized:{' '}
                                        {error.details.searchDetails.isLocalized ? 'Yes' : 'No'}
                                      </Typography>
                                      {error.details.searchDetails.searchedLocales && (
                                        <Typography variant="pi">
                                          • Searched Locales:{' '}
                                          {error.details.searchDetails.searchedLocales.join(', ')}
                                        </Typography>
                                      )}
                                      {error.details.searchDetails.triedVariations &&
                                        error.details.searchDetails.triedVariations.length > 1 && (
                                          <Typography variant="pi">
                                            • Tried Variations:{' '}
                                            {error.details.searchDetails.triedVariations.join(', ')}
                                          </Typography>
                                        )}
                                    </Box>
                                  )}

                                  {error.details.relationTarget && (
                                    <Box padding={2} background="neutral100" marginBottom={2}>
                                      <Typography variant="omega" fontWeight="semiBold">
                                        Relation Information:
                                      </Typography>
                                      <Typography variant="pi">
                                        • Target: {error.details.relationTarget}
                                      </Typography>
                                      <Typography variant="pi">
                                        • Locale: {error.details.locale || 'not specified'}
                                      </Typography>
                                    </Box>
                                  )}
                                </Box>

                                <Typography
                                  display="block"
                                  tag="pre"
                                  padding={2}
                                  background="neutral50"
                                  fontSize={1}
                                >
                                  {JSON.stringify(error.details, null, 2)}
                                </Typography>
                              </>
                            )}
                          </Box>
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
