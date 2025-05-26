// Define interface for preferences
interface Preferences {
  applyFilters: boolean;
  deepness: number;
}

const PREFERENCES_KEY = 'preferences';

const DEFAULT_PREFERENCES: Preferences = {
  applyFilters: false,
  deepness: 5,
};

export const useLocalStorage = () => {
  const getPreferences = (): Preferences => {
    const preferences = localStorage.getItem(PREFERENCES_KEY);

    return preferences != null
      ? { ...DEFAULT_PREFERENCES, ...JSON.parse(preferences) }
      : { ...DEFAULT_PREFERENCES };
  };

  const updatePreferences = (partialPreferences: Partial<Preferences>): void => {
    const preferences = getPreferences();

    return localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ ...preferences, ...partialPreferences })
    );
  };

  const getItem = (key: string): string | null => {
    return localStorage.getItem(key);
  };

  const setItem = (key: string, value: string): void => {
    return localStorage.setItem(key, value);
  };

  return {
    getPreferences,
    updatePreferences,
    getItem,
    setItem,
  };
};
