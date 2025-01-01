import { Modal, Button, Typography, Flex, Grid, Loader, SingleSelect, SingleSelectOption, Checkbox, Field } from '@strapi/design-system';
import { Download } from '@strapi/icons';

import pick from 'lodash/pick';
import range from 'lodash/range';
import qs from 'qs';
import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useFetchClient } from '@strapi/admin/strapi-admin';

import { PLUGIN_ID } from '../../pluginId';
import { useAlerts } from '../../hooks/useAlerts';
import { useDownloadFile } from '../../hooks/useDownloadFile';
import { useI18n } from '../../hooks/useI18n';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useSlug } from '../../hooks/useSlug';
import { dataFormatConfigs, dataFormats } from '../../utils/dataFormats';
import { handleRequestErr } from '../../utils/error';
import { Editor } from '../Editor';
import type { FetchError } from '@strapi/strapi/admin';

export interface ExportOptions {
    exportFormat: typeof dataFormats[keyof typeof dataFormats];
    applyFilters: boolean;
    relationsAsId: boolean;
    deepness: number;
    exportPluginsContentTypes: boolean;
    exportAllLocales: boolean;
    exportRelations: boolean;
    deepPopulateRelations: boolean;
    deepPopulateComponentRelations: boolean;
}

export interface ExportModalProps {
    availableExportFormats?: Array<typeof dataFormats[keyof typeof dataFormats]>;
    unavailableOptions?: string[];
    documentIds?: string[] | null;
}

const DEFAULT_OPTIONS = {
    exportFormat: dataFormats.JSON_V3,
    applyFilters: false,
    relationsAsId: false,
    deepness: 5,
    exportPluginsContentTypes: false,
    exportAllLocales: false,
    exportRelations: false,
    deepPopulateRelations: false,
    deepPopulateComponentRelations: false,
};

const isFetchError = (err: unknown): err is FetchError => {
    return typeof err === 'object' && err !== null && 'name' in err && err.name === 'FetchError';
};

export const useExportModal = ({
    availableExportFormats = [dataFormats.CSV, dataFormats.JSON_V2, dataFormats.JSON_V3, dataFormats.JSON],
    unavailableOptions = [],
    documentIds = null
}: ExportModalProps) => {

    const { i18n } = useI18n();
    const { search } = useLocation();
    const { downloadFile, withTimestamp } = useDownloadFile();
    const { slug, isSlugWholeDb } = useSlug();
    const { notify } = useAlerts();
    const { getPreferences } = useLocalStorage();
    const { post } = useFetchClient();

    const [options, setOptions] = useState<ExportOptions>(() => ({ ...DEFAULT_OPTIONS, ...getPreferences() }));
    const [data, setData] = useState<null | string | Record<string, string>>(null);
    const [fetchingData, setFetchingData] = useState(false);
    const [isOpen, setIsOpen] = useState(false);

    const handleSetOption = <K extends keyof ExportOptions>(
        optionName: K,
        value: ExportOptions[K]
    ) => {
        setOptions(prev => ({ ...prev, [optionName]: value }));
    };

    const shouldShowOption = (optionName: string) => unavailableOptions.indexOf(optionName) === -1;

    const getData = async () => {
        setFetchingData(true);
        try {
            console.log('fetching data');
            const res = await post(`/${PLUGIN_ID}/export/contentTypes`, {
                data: {
                    slug,
                    search: qs.stringify(pick(qs.parse(search), ['filters', 'sort'])),
                    applySearch: options.applyFilters,
                    exportFormat: options.exportFormat,
                    relationsAsId: options.relationsAsId,
                    deepness: options.deepness,
                    exportPluginsContentTypes: options.exportPluginsContentTypes,
                    documentIds: documentIds ?? undefined,
                    exportAllLocales: options.exportAllLocales,
                    exportRelations: options.exportRelations,
                    deepPopulateRelations: options.deepPopulateRelations,
                    deepPopulateComponentRelations: options.deepPopulateComponentRelations
                }
            });
            setData(res.data);
        } catch (err: unknown) {
            if (isFetchError(err)) {
                handleRequestErr(err as Error, {
                    403: () => notify(
                        i18n('plugin.message.export.error.forbidden.title'),
                        i18n('plugin.message.export.error.forbidden.message'), 
                        'danger'
                    ),
                    412: () => notify(
                        i18n('plugin.message.export.error.idfield.title'),
                        err.message,
                        'danger'
                    ),
                    default: () => notify(
                        i18n('plugin.message.export.error.unexpected.title'), 
                        i18n('plugin.message.export.error.unexpected.message'), 
                        'danger'
                    ),
                });
            } else {

                notify(
                    i18n('plugin.message.export.error.unexpected.title'), 
                    i18n('plugin.message.export.error.unexpected.message'), 
                    'danger'
                );
            }
        } finally {
            setFetchingData(false);
        }
    };

    const writeDataToFile = async () => {
        const config = dataFormatConfigs[options.exportFormat];
        if (!config) {
            throw new Error(`File extension ${options.exportFormat} not supported to export data.`);
        }

        let dataToCopy: string;
        if (typeof data === 'object') {
            dataToCopy = data?.data as string
        } else {
            dataToCopy = data as string
        }

        const { fileExt, fileContentType } = config;
        const fileName = `export_${slug}.${fileExt}`.replaceAll(':', '-').replaceAll('--', '-');
        downloadFile(dataToCopy, withTimestamp(fileName), `${fileContentType};charset=utf-8;`);
    };

    const copyToClipboard = () => {
        let dataToCopy: string;
        if (typeof data === 'object') {
            dataToCopy = data?.data as string
        } else {
            dataToCopy = data as string
        }
        navigator.clipboard.writeText(dataToCopy);
        notify(i18n('plugin.export.copied'), '', 'success');
    };

    const clearData = () => {
        setData(null);
    };

    const resetOptions = () => {
        const storedPreferences = getPreferences();
        setOptions({ ...DEFAULT_OPTIONS, ...storedPreferences });
        setData(null);
        setFetchingData(false);
    };

    const handleOpenChange = (open: boolean) => {
        setIsOpen(open);
        if (open) {
            resetOptions();
        }
    };

    const shouldShowDeepnessOption = () => {
        return shouldShowOption('deepness') && options.exportFormat !== dataFormats.JSON_V3;
    };


    return {
        options,
        setOptions,
        data,
        setData,
        fetchingData,
        setFetchingData,
        isOpen,
        setIsOpen,
        handleSetOption,
        shouldShowOption,
        getData,
        writeDataToFile,
        copyToClipboard,
        clearData,
        resetOptions,
        handleOpenChange,
        shouldShowDeepnessOption,
        availableExportFormats,
        unavailableOptions,
        slug,
        isSlugWholeDb
    }
}

// Modal content React component using useExportModal hook
export const ExportModalContent: React.FC<{ state: ReturnType<typeof useExportModal> }> = ({ state }) => {
    const { i18n } = useI18n();
    return <>
        {state.fetchingData && (
            <Flex justifyContent="center">
                <Loader>{i18n('plugin.export.fetching-data')}</Loader>
            </Flex>
        )}
        {!state.data && !state.fetchingData && (
            <>
                {state.shouldShowOption('exportFormat') && (
                    <Grid.Root gap={2}>
                        <Grid.Item xs={12}>
                            <Typography fontWeight="bold" textColor="neutral800" tag="h2">{i18n('plugin.export.export-format')}</Typography>
                        </Grid.Item>
                        <Grid.Item xs={12}>
                            <SingleSelect
                                id="export-format"
                                required
                                placeholder={i18n('plugin.export.export-format')}
                                value={state.options.exportFormat}
                                onChange={(value) => state.handleSetOption('exportFormat', value as string)}
                            >
                                {state.availableExportFormats.map((format) => (
                                    <SingleSelectOption key={format} value={format}>
                                        {i18n(`plugin.data-format.${format}`)}
                                    </SingleSelectOption>
                                ))}
                            </SingleSelect>
                        </Grid.Item>
                    </Grid.Root>
                )}

                <Flex direction="column" alignItems="start" gap="16px" marginTop={6}>
                    <Typography fontWeight="bold" textColor="neutral800" tag="h2">
                        {i18n('plugin.export.options')}
                    </Typography>
                    {state.shouldShowOption('relationsAsId') && (
                        <Checkbox checked={state.options.relationsAsId} onCheckedChange={(value) => state.handleSetOption('relationsAsId', value==true)}>
                            {i18n('plugin.export.relations-as-id')}
                        </Checkbox>
                    )}
                    {state.shouldShowOption('applyFilters') && (
                        <Checkbox checked={state.options.applyFilters} onCheckedChange={(value) => state.handleSetOption('applyFilters', value==true)}>
                            {i18n('plugin.export.apply-filters-and-sort')}
                        </Checkbox>
                    )}
                    {state.shouldShowOption('exportPluginsContentTypes') && (
                        <Checkbox checked={state.options.exportPluginsContentTypes} onCheckedChange={(value) => state.handleSetOption('exportPluginsContentTypes', value==true)}>
                            {i18n('plugin.export.plugins-content-types')}
                        </Checkbox>
                    )}
                    {state.shouldShowOption('exportAllLocales') && (
                        <Checkbox 
                            checked={state.options.exportAllLocales} 
                            onCheckedChange={(value) => state.handleSetOption('exportAllLocales', value==true)}
                        >
                            {i18n('plugin.export.export-all-locales')}
                        </Checkbox>
                    )}
                    {state.shouldShowOption('exportRelations') && (
                        <Checkbox 
                            checked={state.options.exportRelations} 
                            onCheckedChange={(value) => state.handleSetOption('exportRelations', value==true)}
                        >
                            {i18n('plugin.export.export-relations')}
                        </Checkbox>
                    )}
                    {state.shouldShowOption('exportRelations') && state.options.exportRelations && (
                        <Flex gap={2}>
                            <Checkbox 
                                checked={state.options.deepPopulateRelations} 
                                onCheckedChange={(value) => state.handleSetOption('deepPopulateRelations', value==true)}
                            >
                                {i18n('plugin.export.deep-populate-relations')}
                            </Checkbox>
                            <Checkbox 
                                checked={state.options.deepPopulateComponentRelations} 
                                onCheckedChange={(value) => state.handleSetOption('deepPopulateComponentRelations', value==true)}
                            >
                                {i18n('plugin.export.deep-populate-component-relations')}
                            </Checkbox>
                        </Flex>
                    )}
                    {state.shouldShowDeepnessOption() && (
                        <>
                            <Flex direction="column" gap={2} marginTop={3}>
                                <Grid.Item xs={12}>
                                    <Typography fontWeight="bold" textColor="neutral800" tag="h2">
                                        {i18n('plugin.export.deepness')}
                                    </Typography>
                                </Grid.Item>
                                <Grid.Item xs={12}>
                                    <SingleSelect
                                        placeholder={i18n('plugin.export.deepness')}
                                        value={state.options.deepness}
                                        onChange={(value) => state.handleSetOption('deepness', parseInt(value as string, 10))}
                                    >
                                        {range(1, 21).map((deepness) => (
                                            <SingleSelectOption key={deepness} value={deepness}>
                                                {deepness}
                                            </SingleSelectOption>
                                        ))}
                                    </SingleSelect>
                                </Grid.Item>
                            </Flex>
                        </>
                    )}
                </Flex>
            </>
        )}
        {state.data && !state.fetchingData && (
            <Editor content={state.data} language={dataFormatConfigs[state.options.exportFormat].language} />
        )}
    </>
}

// Modal footer React component using useExportModal hook
export const ExportModalFooter: React.FC<{ state: ReturnType<typeof useExportModal> }> = ({ state }) => {
    const { i18n } = useI18n();
    return <>
        {!!state.data && (
            <Button variant="tertiary" onClick={state.clearData}>
                {i18n('plugin.cta.back-to-options')}
            </Button>
        )}
        {!state.data && <Button onClick={state.getData}>{i18n('plugin.cta.get-data')}</Button>}
        {!!state.data && (
            <>
                <Button variant="secondary" onClick={state.copyToClipboard}>
                    {i18n('plugin.cta.copy-to-clipboard')}
                </Button>
                <Button onClick={state.writeDataToFile}>{i18n('plugin.cta.download-file')}</Button>
            </>
        )}
    </>
}