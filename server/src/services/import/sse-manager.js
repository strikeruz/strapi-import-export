import { getService } from '../../utils/utils.js';

class SSEManager {
  constructor() {
    this.client = null;
    this.currentJob = {
      status: 'idle',
      message: '',
      progress: 0,
    };
  }

  setClient(client) {
    this.client = client;

    // Send current job status to the new client
    if (this.client && this.currentJob.status !== 'idle') {
      this.client.send('status', this.currentJob);
    }
  }

  clearClient() {
    this.client = null;
  }

  updateStatus(status, message, progress) {
    this.currentJob = {
      status,
      message: message || '',
      progress: progress || 0,
    };

    if (this.client) {
      this.client.send('status', this.currentJob);
    }
  }

  sendComplete(result) {
    // Set the import status to false when completing
    getService('import').setImportInProgress(false);

    if (this.client) {
      this.client.send('complete', result);

      // Reset job status after completion
      setTimeout(() => {
        this.updateStatus('idle', '', 0);
        this.client?.send('close', {});
      }, 1000);
    }
  }

  sendError(error) {
    // Set the import status to false when error occurs
    getService('import').setImportInProgress(false);

    if (this.client) {
      this.client.send('error', {
        message: error.message,
        stack: error.stack,
      });
    }
  }
}

export const sseManager = new SSEManager();
