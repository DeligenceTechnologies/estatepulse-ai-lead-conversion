import { Module } from '@nestjs/common';
import { GoogleSheetsModule } from '@/google-sheets/google-sheets.module';
import { FileImportController } from './file-import.controller';
import { FileImportService } from './file-import.service';

@Module({
  imports: [GoogleSheetsModule],
  controllers: [FileImportController],
  providers: [FileImportService],
})
export class FileImportModule {}
