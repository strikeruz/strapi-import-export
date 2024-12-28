import { useState } from 'react';

// Define a generic type parameter T for the attributes
export const useForm = <T extends Record<string, any>>(attributes: T) => {
  const [options, setOptions] = useState<T>(attributes);

  const getOption = (key: keyof T): T[keyof T] => {
    return options[key];
  };

  const setOption = (key: keyof T, value: T[keyof T]): void => {
    setOptions({ ...options, [key]: value });
  };

  return { options, getOption, setOption };
};
