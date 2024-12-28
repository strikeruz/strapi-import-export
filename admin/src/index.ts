import { getTranslation } from './utils/getTranslation';
import { PLUGIN_ID } from './pluginId';
import { Initializer } from './components/Initializer';
import { PluginIcon } from './components/PluginIcon';
import {pluginPermissions} from './permissions';
import { Download } from '@strapi/icons';
// @ts-ignore
import { Alerts } from './components/Injected/Alerts/Alerts';
// @ts-ignore
import { ImportModal } from './components/ImportModal/ImportModal';
// @ts-ignore
// import { ExportModal } from './components/ExportModal/ExportModal';
import translations from './translations'; 
// @ts-ignore
import { InjectedImportExportSingleType } from './components/InjectedImportExportSingleType/InjectedImportExportSingleType';
// @ts-ignore
import { InjectedExportCollectionType } from './components/InjectedExportCollectionType/InjectedExportCollectionType';

import type { BulkActionComponent, ContentManagerPlugin } from '../../node_modules/@strapi/content-manager/dist/admin/src/content-manager';
import type { StrapiApp } from '@strapi/strapi/admin';
import { BULK_ACTIONS } from './components/BulkExportModal/BulkExportModal';

export default {
  register(app: any) {
    app.addMenuLink({
      to: `plugins/${PLUGIN_ID}`,
      icon: PluginIcon,
      intlLabel: {
        id: `${PLUGIN_ID}.plugin.name`,
        defaultMessage:'Import Export',
      },
      permissions: pluginPermissions.main,
      Component: async () => {
        const { App } = await import('./pages/App');

        return App;
      },
    });

    app.registerPlugin({
      id: PLUGIN_ID,
      initializer: Initializer,
      isReady: false,
      name: PLUGIN_ID,
    });
  },

  bootstrap(app: StrapiApp) {
    // app.injectContentManagerComponent('listView', 'actions', {
    //   name: `${PLUGIN_ID}-alerts`,
    //   Component: Alerts,
    // });
    app.getPlugin('content-manager').injectComponent('listView', 'actions', {
      name: `${PLUGIN_ID}-alerts`,
      Component: Alerts,
    });
    // app.injectContentManagerComponent('listView', 'actions', {
    //   name: `${pluginId}-import`,
    //   Component: ImportButton,
    // });
    app.getPlugin('content-manager').injectComponent('listView', 'actions', {
      name: `${PLUGIN_ID}-import`,
      Component: ImportModal,
    });
    // app.injectContentManagerComponent('listView', 'actions', {
      //   name: `${pluginId}-export`,
      //   Component: InjectedExportCollectionType,
      // });

      const ExportModal = InjectedExportCollectionType;

      app.getPlugin('content-manager').injectComponent('listView', 'actions', {
      name: `${PLUGIN_ID}-export`,
      Component: ExportModal,
    });
      
    // app.injectContentManagerComponent('editView', 'right-links', {
    //   name: `${pluginId}-alerts`,
    //   Component: Alerts,
    // });
    app.getPlugin('content-manager').injectComponent('editView', 'right-links', {
      name: `${PLUGIN_ID}-alerts`,
      Component: Alerts,
    });
    // app.injectContentManagerComponent('editView', 'right-links', {
      //   name: `${pluginId}-import-export`,
    //   Component: InjectedImportExportSingleType,
    // });
    app.getPlugin('content-manager').injectComponent('editView', 'right-links', {
      name: `${PLUGIN_ID}-import-export`,
      Component: InjectedImportExportSingleType,
    });
    // const bulkAction: BulkActionComponent = (props) => {
    //   return {
    //     label: 'Export',
    //     onClick: (event) => {
    //       console.log(JSON.stringify(props));
    //     },
    //     dialog: {
    //       type: 'modal',
    //       title: 'Export',
    //       content
    //     }
    //   };
    // };

    (app.getPlugin('content-manager') as unknown as ContentManagerPlugin['config']).apis.addBulkAction(BULK_ACTIONS);

  },

  async registerTrads(app: any) {
    const { locales } = app;

    const importedTranslations = [
      {
        data: translations.en,
        locale: 'en'
      },
      {
        data: translations.uk,
        locale: 'uk'
      }
    ];

    return importedTranslations;
  },

  // async registerTrads(app: any) {
  //   const { locales } = app;

  //   const importedTranslations = await Promise.all(
  //     (locales as string[]).map((locale) => {
  //       return import(`./translations/${locale}.json`)
  //         .then(({ default: data }) => {
  //           return {
  //             data: getTranslation(data),
  //             locale,
  //           };
  //         })
  //         .catch(() => {
  //           return {
  //             data: {},
  //             locale,
  //           };
  //         });
  //     })
  //   );

  //   return importedTranslations;
  // },
};

