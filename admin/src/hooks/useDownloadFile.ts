export const useDownloadFile = () => {
  const downloadFile = (content: string, filename: string, contentType: string): void => {
    var blob = new Blob([content], { type: contentType });
    var url = URL.createObjectURL(blob);

    var link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    link.click();
  };

  const withTimestamp = (fileName: string): string => {
    const ts = new Date().toISOString().replace(/\D/g, '').substring(2);

    const name = fileName.split('.').slice(0, -1).join('.').concat(`_${ts}`);
    const extension = fileName.split('.').slice(-1);
    return [name, extension].join('.');
  };

  return {
    downloadFile,
    withTimestamp,
  };
};
