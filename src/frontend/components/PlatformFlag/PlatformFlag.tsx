// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import * as S from './PlatformFlag.styled';

const platform = process.env.NEXT_PUBLIC_PLATFORM || 'local';

const PlatformFlag = () => {
  return (
      platform ? <S.Block id="platform">{platform}</S.Block> : ''
  );
};

export default PlatformFlag;
