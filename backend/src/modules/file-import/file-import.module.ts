import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { GoogleSheetsModule } from '../google-sheets/google-sheets.module';
import { FileImportController } from './file-import.controller';
import { FileImportService } from './file-import.service';

/** CSV / XLSX lead import. AuthModule for the guards; GoogleSheetsModule for the import engine. */
@Module({
  imports: [AuthModule, GoogleSheetsModule],
  controllers: [FileImportController],
  providers: [FileImportService],
})
export class FileImportModule {}
