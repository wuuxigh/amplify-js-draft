// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { TransferProgressEvent } from '../../../../../types';
import { ResolvedS3Config } from '../../../types/options';
import { uploadPart } from '../../../utils/client/s3data';
import { logger } from '../../../../../utils';
import { CRC32Checksum, calculateContentCRC32 } from '../../../utils/crc32';
import { calculateContentMd5 } from '../../../utils';

import { PartToUpload } from './getDataChunker';

interface UploadPartExecutorOptions {
	dataChunkerGenerator: Generator<PartToUpload, void, undefined>;
	completedPartNumberSet: Set<number>;
	s3Config: ResolvedS3Config;
	abortSignal: AbortSignal;
	bucket: string;
	finalKey: string;
	uploadId: string;
	isObjectLockEnabled?: boolean;
	useCRC32Checksum?: boolean;
	onPartUploadCompletion(
		partNumber: number,
		eTag: string,
		crc32: string | undefined,
	): void;
	onProgress?(event: TransferProgressEvent): void;
}

export const uploadPartExecutor = async ({
	dataChunkerGenerator,
	completedPartNumberSet,
	s3Config,
	abortSignal,
	bucket,
	finalKey,
	uploadId,
	onPartUploadCompletion,
	onProgress,
	isObjectLockEnabled,
	useCRC32Checksum,
}: UploadPartExecutorOptions) => {
	let transferredBytes = 0;
	for (const { data, partNumber, size } of dataChunkerGenerator) {
		if (abortSignal.aborted) {
			logger.debug('upload executor aborted.');
			break;
		}

		if (completedPartNumberSet.has(partNumber)) {
			logger.debug(`part ${partNumber} already uploaded.`);
			transferredBytes += size;
			onProgress?.({
				transferredBytes,
			});
		} else {
			// handle cancel error
			let crc32: CRC32Checksum | undefined;
			if (useCRC32Checksum) {
				crc32 = await calculateContentCRC32(data);
			}
			const { ETag: eTag } = await uploadPart(
				{
					...s3Config,
					abortSignal,
					onUploadProgress: (event: TransferProgressEvent) => {
						const { transferredBytes: currentPartTransferredBytes } = event;
						onProgress?.({
							transferredBytes: transferredBytes + currentPartTransferredBytes,
						});
					},
				},
				{
					Bucket: bucket,
					Key: finalKey,
					UploadId: uploadId,
					Body: data,
					PartNumber: partNumber,
					ChecksumCRC32: crc32?.checksum,
					// if checksum is undefined in react native
					ContentMD5:
						crc32 === undefined && isObjectLockEnabled
							? await calculateContentMd5(data)
							: undefined,
				},
			);
			transferredBytes += size;
			// eTag will always be set even the S3 model interface marks it as optional.
			onPartUploadCompletion(partNumber, eTag!, crc32?.checksum);
		}
	}
};
