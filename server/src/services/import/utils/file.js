import { strings } from '@strapi/utils';
import fs from 'fs';
import fse from 'fs-extra';
import last from 'lodash/last';
import trim from 'lodash/trim';
import os from 'os';
import path from 'path';
import { isObjectSafe } from '../../../../libs/objects.js';

async function findOrImportFile(fileEntry, user, { allowedFileTypes }) {
  let obj = {};
  if (typeof fileEntry === 'string') {
    obj.url = fileEntry;
  } else if (isObjectSafe(fileEntry)) {
    obj = fileEntry;
  } else {
    throw new Error(
      `Invalid data format '${typeof fileEntry}' to import media. Only 'string', 'number', 'object' are accepted.`
    );
  }

  // First try to find file with existing hash or name
  let file = await findFile(obj, user, allowedFileTypes);
  if (file) {
    if (isExtensionAllowed(file.ext.substring(1), allowedFileTypes)) {
      return file;
    }
    return null;
  }

  // If not found and we have a URL, process it
  if (obj.url) {
    // Check if URL is absolute
    const isAbsoluteUrl = obj.url.startsWith('http://') || obj.url.startsWith('https://');

    if (isAbsoluteUrl) {
      const fileData = getFileDataFromRawUrl(obj.url);
      // Only override name/hash if they weren't provided
      if (!obj.name) {
        obj.name = fileData.name;
      }
      if (!obj.hash) {
        obj.hash = fileData.hash;
      }

      // Try finding again with the new hash/name
      file = await findFile(obj, user, allowedFileTypes);
      if (file && isExtensionAllowed(file.ext.substring(1), allowedFileTypes)) {
        console.log('Found file after processing absolute URL');
        return file;
      }
    } else {
      console.log('Skipping URL processing for relative URL:', obj.url);
    }
  }

  return null;
}

const findFile = async ({ hash, name, url, alternativeText, caption }, user, allowedFileTypes) => {
  let file = null;

  if (!file && hash) {
    //deprecated:
    // [file] = await strapi.entityService.findMany('plugin::upload.file', {
    //   filters: {
    //     hash: {
    //       $startsWith: hash,
    //     },
    //   },
    //   limit: 1,
    // });
    [file] = await strapi.documents('plugin::upload.file').findMany({
      filters: {
        hash: { $startsWith: hash },
      },
      limit: 1,
    });
  }
  if (!file && name) {
    //deprecated:
    // [file] = await strapi.entityService.findMany('plugin::upload.file', { filters: { name }, limit: 1 });
    [file] = await strapi
      .documents('plugin::upload.file')
      .findMany({ filters: { name }, limit: 1 });
  }
  if (!file && url) {
    const checkResult = isValidFileUrl(url, allowedFileTypes);
    if (checkResult.isValid) {
      file = await findFile(
        { hash: checkResult.fileData.hash, name: checkResult.fileData.fileName },
        user,
        allowedFileTypes
      );

      if (!file) {
        file = await importFile(
          {
            url: checkResult.fileData.rawUrl,
            name: name,
            alternativeText: alternativeText,
            caption: caption,
          },
          user
        );
      }
    }
  }

  return file;
};

const importFile = async ({ url, name, alternativeText, caption }, user) => {
  let file;
  try {
    file = await fetchFile(url);
    // console.log('importFile', JSON.stringify(file, null, 2));

    // let [uploadedFile] = await strapi
    //   .plugin('upload')
    //   .service('upload')
    //   .upload(
    //     {
    //       files: {
    //         name: file.name,
    //         type: file.type,
    //         size: file.size,
    //         path: file.path,
    //       },
    //       data: {
    //         fileInfo: {
    //           name: name || file.name,
    //           alternativeText: alternativeText || '',
    //           caption: caption || '',
    //         },
    //       },
    //     },
    //     { user },
    //   );

    let [uploadedFile] = await strapi
      .plugin('upload')
      .service('upload')
      .upload(
        {
          files: {
            filepath: file.path,
            originalFileName: file.name,
            size: file.size,
            mimetype: file.type,
          },
          data: {
            fileInfo: {
              name: name || file.name,
              alternativeText: alternativeText || '',
              caption: caption || '',
            },
          },
        },
        { user }
      );

    return uploadedFile;
  } catch (err) {
    strapi.log.error(err);
    throw err;
  } finally {
    if (file?.path) {
      deleteFileIfExists(file?.path);
    }
  }
};

const fetchFile = async (url) => {
  // console.log('fetchFile', url);
  try {
    const response = await fetch(url);
    const contentType = response.headers.get('content-type')?.split(';')?.[0] || '';
    const contentLength = parseInt(response.headers.get('content-length') || '0', 10) || 0;
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const fileData = getFileDataFromRawUrl(url);
    const filePath = await writeFile(fileData.name, buffer);
    return {
      name: fileData.name,
      type: contentType,
      size: contentLength,
      path: filePath,
    };
  } catch (error) {
    throw new Error(`Tried to fetch file from url ${url} but failed with error: ${error.message}`);
  }
};

const writeFile = async (name, content) => {
  const tmpWorkingDirectory = await fse.mkdtemp(path.join(os.tmpdir(), 'strapi-upload-'));

  const filePath = path.join(tmpWorkingDirectory, name);
  try {
    fs.writeFileSync(filePath, content);
    return filePath;
  } catch (err) {
    strapi.log.error(err);
    throw err;
  }
};

const deleteFileIfExists = (filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    fs.rmSync(filePath);
  }
};

const isValidFileUrl = (url, allowedFileTypes) => {
  try {
    const fileData = getFileDataFromRawUrl(url);

    return {
      isValid: isExtensionAllowed(fileData.extension, allowedFileTypes),
      fileData: {
        hash: fileData.hash,
        fileName: fileData.name,
        rawUrl: url,
      },
    };
  } catch (err) {
    strapi.log.error(err);
    return {
      isValid: false,
      fileData: {
        hash: '',
        fileName: '',
        rawUrl: '',
      },
    };
  }
};

const isExtensionAllowed = (ext, allowedFileTypes) => {
  const checkers = allowedFileTypes.map(getFileTypeChecker);
  return checkers.some((checker) => checker(ext));
};

// We should probably get the actual mime types, but that would require downloading the file before we can check it.
const ALLOWED_AUDIOS = ['mp3', 'wav', 'ogg'];
const ALLOWED_IMAGES = [
  'png',
  'gif',
  'jpg',
  'jpeg',
  'svg',
  'bmp',
  'tif',
  'tiff',
  'webp',
  'heic',
  'heif',
  'ico',
];
const ALLOWED_VIDEOS = ['mp4', 'avi', 'webm', 'hevc', 'heifc'];

/** See Strapi file allowedTypes for object keys. */
const fileTypeCheckers = {
  any: (ext) => true,
  audios: (ext) => ALLOWED_AUDIOS.includes(ext),
  files: (ext) => true,
  images: (ext) => ALLOWED_IMAGES.includes(ext),
  videos: (ext) => ALLOWED_VIDEOS.includes(ext),
};

const getFileTypeChecker = (type) => {
  const checker = fileTypeCheckers[type];
  if (!checker) {
    throw new Error(`Strapi file type ${type} not handled.`);
  }
  return checker;
};

const getFileDataFromRawUrl = (rawUrl) => {
  // console.log('getFileDataFromRawUrl', rawUrl);
  const parsedUrl = new URL(decodeURIComponent(rawUrl));

  const name = trim(parsedUrl.pathname, '/').replace(/\//g, '-');
  const extension = parsedUrl.pathname.split('.').pop()?.toLowerCase() || '';
  const hash = strings.nameToSlug(name.slice(0, -(extension.length + 1)) || '', {
    separator: '_',
    lowercase: false,
  });

  return {
    hash,
    name,
    extension,
  };
};

export { findOrImportFile };
