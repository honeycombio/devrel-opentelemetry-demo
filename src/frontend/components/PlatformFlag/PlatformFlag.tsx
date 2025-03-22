// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import * as S from './PlatformFlag.styled';
import { ReactNode } from 'react';

const { NEXT_PUBLIC_PLATFORM = 'local' } = typeof window !== 'undefined' ? window.ENV : {};
const platform = NEXT_PUBLIC_PLATFORM;

type PlatformFlagProps = {
  children?: ReactNode;
};

const PlatformFlag = ({ children }: PlatformFlagProps) => {
  return (
      <S.Block>
        {children || platform}
      </S.Block>
  );
};

export default PlatformFlag;
