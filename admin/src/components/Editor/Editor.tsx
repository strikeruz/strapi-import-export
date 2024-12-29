import './style.css';

import React, { useEffect, useState } from 'react';
import CodeMirror from "@uiw/react-codemirror";

import { ReactCodeMirrorProps } from '@uiw/react-codemirror';

export const Editor = ({ 
  content = '', 
  language = 'json', 
  readOnly = false, 
  onChange,
  style 
}: {
  content?: string | object;
  language?: string;
  readOnly?: boolean;
  onChange?: ReactCodeMirrorProps['onChange'];
  style?: React.CSSProperties;
}) => {
 
  const [codeMirrorContent, setCodeMirrorContent] = useState('');

  useEffect(() => {
    console.log('content', content);
    if (typeof content === 'object') {
      if((content as unknown as {data: string}).data){
        setCodeMirrorContent((content as unknown as {data: string}).data);
      }else{
        setCodeMirrorContent(JSON.stringify(content, null, 2));
      }
    }else{
      setCodeMirrorContent(content);
    }

  }, [content, language]);
 
  return (
    <>
    <CodeMirror
      className="plugin-ie-editor"
      basicSetup={{lineNumbers: true}}
      readOnly={false}
      style={style}
      height="40vh"
      theme="dark"
      value={codeMirrorContent}
      onChange={onChange}
      editable={!readOnly}
      // extensions={[]}
    />
    </>
  );
};
