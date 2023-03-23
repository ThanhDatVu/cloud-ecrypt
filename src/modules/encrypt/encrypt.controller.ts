import httpStatus from 'http-status';
import { Request, Response } from 'express';
import mongoose from 'mongoose';
import catchAsync from '../utils/catchAsync';
import ApiError from '../errors/ApiError';
import pick from '../utils/pick';
import { IOptions } from '../paginate/paginate';
import * as encryptService from './encrypt.service';
import * as metadataService from '../metadata/metadata.service';
// import uuid v4
import pkg from 'uuid';
import { is } from '@babel/types';
const { v4 } = pkg;

const symKeyFolder: string = process.env['SYM_KEY_FOLDER'] || 'sym_key';
const asymKeyFolder: string = process.env['ASYM_KEY_FOLDER'] || 'asym_key';
const imagesFolder: string = process.env['IMAGES_FOLDER'] || 'images';
const systemPublicKey: string = `${asymKeyFolder}public.pem`;
const systemPrivateKey: string = `${asymKeyFolder}private.pem`;

export const encryptBlowfish = catchAsync(async (req: Request, res: Response) => {
  const inputFile = req.body.inputFile || 'input.png';
  // const symKeyFolder: string = process.env['SYM_KEY_FOLDER'] || 'sym_key';
  // const asymKeyFolder: string = process.env['ASYM_KEY_FOLDER'] || 'asym_key';

  // format d473b1c9-16f9-49b8-b98b-812b9983a0dd-kekw.png to d473b1c9-16f9-49b8-b98b-812b9983a0dd-kekw-encrypted.png
  const [fileName, fileExtension] = inputFile.split('.');
  const pathToEncryptedFile = `${imagesFolder}${fileName}-encrypted.${fileExtension}`;
  const fileID = v4();
  // generate blowfish key
  // await keyManagementService.generateBlowfishKey(`${symKeyFile}`);
  const { publicFileKeyPath, sharedSecretPath, privateFileKeyPath, ecdhKeyExchangeResult } =
    await encryptService.ecdhKeyExchange(`${systemPublicKey}`, `${fileID}`);  

  // encrypt file with blowfish algorithm
  const { stdoutEncrypt, encryptedFilePath, encryptResult } = await encryptService.encryptBlowfish(
    `${sharedSecretPath}`,
    `${imagesFolder}${inputFile}`,
    pathToEncryptedFile
  );
  // hash the original file
  const md5 = await encryptService.hashMD5(`${imagesFolder}${inputFile}`);

  // sign the hash with system private key
  const { signResult, signaturePath } = await encryptService.signECDSA(md5, `${systemPrivateKey}`, fileID);

  const metadata = await metadataService.createMetadata({
    fileName: inputFile,
    fileUuid: fileID,
    hashValue: md5,
    signaturePath,
    publicFileKeyPath,
    encryptedFilePath,
  });

  const fileContents = await encryptService.getFilesContent({
    signatureContent: `${signaturePath}`,
    systemPrivateKeyContent: `${systemPrivateKey}`,
    systemPublicKeyContent: `${systemPublicKey}`,
    filePublicKeyContent: `${publicFileKeyPath}`,
    filePrivateKeyContent: `${privateFileKeyPath}`,
    sharedSecretContent: `${sharedSecretPath}`,
  });

  res.send({
    metadata,
    encrypt: {
      encryptResult,
      stdoutEncrypt,
    },
    hash: {
      originalHash: md5,
    },
    signECDSA: {
      signResult,
      signaturePath,
    },
    ecdhKeyExchange: {
      ecdhKeyExchangeResult,
      publicFileKeyPath,
      encryptedFilePath,
    },
    fileContents,
  });
});

export const decryptBlowfish = catchAsync(async (req: Request, res: Response) => {
  const metadataId = req.query['metadataId'];
  if (!metadataId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'metadataId is required');
  }

  const metadata = await metadataService.getMetadataById(new mongoose.Types.ObjectId(metadataId.toString()));

  if (!metadata) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Metadata not found');
  }

  const { sharedSecretPath } = await encryptService.ecdhKeyExchange2(
    `${systemPrivateKey}`,
    metadata.publicFileKeyPath,
    metadata.fileUuid
  );

  const [fileName, fileExtension] = metadata.fileName.split('.');
  const decryptedFilePath = `${imagesFolder}${fileName}-decrypted.${fileExtension}`;

  // decrypt file with blowfish algorithm
  const decryptResult = await encryptService.decryptBlowfish(
    `${sharedSecretPath}`,
    `${metadata.encryptedFilePath}`,
    `${decryptedFilePath}`
  );
  // hash the decrypted file
  const md5 = await encryptService.hashMD5(decryptedFilePath);
  // verify the signature with system public key
  const verifyECDSA = await encryptService.verifyECDSA(md5, metadata.signaturePath, `${systemPublicKey}`);

  const fileContents = await encryptService.getFilesContent({
    publicFileKeyContent: `${metadata.publicFileKeyPath}`,
    signatureContent: `${metadata.signaturePath}`,
    systemPrivateKeyContent: `${systemPrivateKey}`,
    systemPublicKeyContent: `${systemPublicKey}`,
    sharedSecretContent: `${sharedSecretPath}`,
  });
  res.send({
    decrypt: {
      result: decryptResult,
      decryptedFilePath,
    },
    hash: {
      decryptedFilehash: md5,
      originalHash: metadata.hashValue,
      isHashEqual: md5 == metadata.hashValue,
    },
    verifyECDSA,
    metadata,
    fileContents,
  });
});
