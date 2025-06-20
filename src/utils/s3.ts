import { 
    S3Client, 
    PutObjectCommand, 
    DeleteObjectCommand, 
    ListObjectsV2Command,
    HeadObjectCommand,
    GetObjectCommand
  } from '@aws-sdk/client-s3';
  import { Upload } from '@aws-sdk/lib-storage';
  import { Readable } from 'stream';
  
  export interface AudioFile {
    key: string;
    name: string;
    size: number;
    lastModified: Date;
    url: string;
  }
  
  export class S3Service {
    private s3Client: S3Client;
    private bucketName: string;
    private baseUrl: string;
  
    constructor() {
      // Initialize S3 client
      this.s3Client = new S3Client({
        region: process.env.AWS_REGION || 'ap-south-1',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string,
        },
      });
  
      this.bucketName = process.env.S3_BUCKET_NAME!;
      this.baseUrl = process.env.S3_BASE_URL!;
  
      // Validate required environment variables
      this.validateConfig();
    }
  
    private validateConfig(): void {
      const required = [
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY', 
        'AWS_REGION',
        'S3_BUCKET_NAME',
        'S3_BASE_URL'
      ];
  
      const missing = required.filter(key => !process.env[key]);
      
      if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
      }
    }
  
    /**
     * Upload a file to S3
     */
    async uploadFile(
      fileName: string, 
      fileBuffer: Buffer, 
      contentType: string = 'audio/mpeg'
    ): Promise<string> {
      try {
        const key = this.sanitizeFileName(fileName);
        
        const upload = new Upload({
          client: this.s3Client,
          params: {
            Bucket: this.bucketName,
            Key: key,
            Body: fileBuffer,
            ContentType: contentType,
            CacheControl: 'max-age=31536000', // 1 year cache
            Metadata: {
              'uploaded-by': 'rdp-soundboard',
              'upload-date': new Date().toISOString(),
            },
          },
        });
  
        await upload.done();
        
        console.log(`✅ [S3] Uploaded: ${key}`);
        return this.getPublicUrl(key);
        
      } catch (error) {
        console.error('❌ [S3] Upload failed:', error);
        throw new Error(`Failed to upload file: ${error}`);
      }
    }
  
    /**
     * Delete a file from S3
     */
    async deleteFile(fileName: string): Promise<void> {
      try {
        const key = this.sanitizeFileName(fileName);
        
        const command = new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        });
  
        await this.s3Client.send(command);
        console.log(`🗑️ [S3] Deleted: ${key}`);
        
      } catch (error) {
        console.error('❌ [S3] Delete failed:', error);
        throw new Error(`Failed to delete file: ${error}`);
      }
    }
  
    /**
     * List all MP3 files in the bucket
     */
    async listFiles(): Promise<AudioFile[]> {
      try {
        const command = new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: '', // No prefix to get all files
          MaxKeys: 1000, // Adjust as needed
        });
  
        const response = await this.s3Client.send(command);
        
        if (!response.Contents) {
          return [];
        }
  
        // Filter for MP3 files and map to AudioFile interface
        const audioFiles: AudioFile[] = response.Contents
          .filter(object => object.Key?.endsWith('.mp3'))
          .map(object => ({
            key: object.Key!,
            name: object.Key!,
            size: object.Size || 0,
            lastModified: object.LastModified || new Date(),
            url: this.getPublicUrl(object.Key!),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
  
        return audioFiles;
        
      } catch (error) {
        console.error('❌ [S3] List files failed:', error);
        throw new Error(`Failed to list files: ${error}`);
      }
    }
  
    /**
     * Check if a file exists in S3
     */
    async fileExists(fileName: string): Promise<boolean> {
      try {
        const key = this.sanitizeFileName(fileName);
        
        const command = new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        });
  
        await this.s3Client.send(command);
        return true;
        
      } catch (error: any) {
        if (error.name === 'NotFound') {
          return false;
        }
        throw error;
      }
    }
  
    /**
     * Get a readable stream for a file (for Discord voice)
     */
    async getFileStream(fileName: string): Promise<Readable> {
      try {
        const key = this.sanitizeFileName(fileName);
        
        const command = new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        });
  
        const response = await this.s3Client.send(command);
        
        if (!response.Body) {
          throw new Error('No file body received');
        }
  
        return response.Body as Readable;
        
      } catch (error) {
        console.error('❌ [S3] Get file stream failed:', error);
        throw new Error(`Failed to get file stream: ${error}`);
      }
    }
  
    /**
     * Get public URL for a file
     */
    getPublicUrl(key: string): string {
      return `${this.baseUrl}/${key}`;
    }
  
    /**
     * Get file information
     */
    async getFileInfo(fileName: string): Promise<{ size: number; lastModified: Date } | null> {
      try {
        const key = this.sanitizeFileName(fileName);
        
        const command = new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        });
  
        const response = await this.s3Client.send(command);
        
        return {
          size: response.ContentLength || 0,
          lastModified: response.LastModified || new Date(),
        };
        
      } catch (error: any) {
        if (error.name === 'NotFound') {
          return null;
        }
        throw error;
      }
    }
  
    /**
     * Get bucket statistics
     */
    async getBucketStats(): Promise<{ fileCount: number; totalSize: number }> {
      try {
        const files = await this.listFiles();
        
        return {
          fileCount: files.length,
          totalSize: files.reduce((sum, file) => sum + file.size, 0),
        };
        
      } catch (error) {
        console.error('❌ [S3] Get bucket stats failed:', error);
        return { fileCount: 0, totalSize: 0 };
      }
    }
  
    /**
     * Clean up corrupted or empty files
     */
    async cleanupFiles(): Promise<string[]> {
      try {
        const files = await this.listFiles();
        const cleanedFiles: string[] = [];
        
        // Remove files smaller than 1KB (likely corrupted)
        for (const file of files) {
          if (file.size < 1024) {
            await this.deleteFile(file.name);
            cleanedFiles.push(file.name);
          }
        }
        
        return cleanedFiles;
        
      } catch (error) {
        console.error('❌ [S3] Cleanup failed:', error);
        throw new Error(`Failed to cleanup files: ${error}`);
      }
    }
  
    /**
     * Sanitize file name for S3 key
     */
    private sanitizeFileName(fileName: string): string {
      // Remove any path separators and ensure .mp3 extension
      const sanitized = fileName.replace(/[\/\\]/g, '');
      return sanitized.endsWith('.mp3') ? sanitized : `${sanitized}.mp3`;
    }
  
    /**
     * Test S3 connection
     */
    async testConnection(): Promise<boolean> {
      try {
        const command = new ListObjectsV2Command({
          Bucket: this.bucketName,
          MaxKeys: 1,
        });
  
        await this.s3Client.send(command);
        console.log('✅ [S3] Connection test successful');
        return true;
        
      } catch (error) {
        console.error('❌ [S3] Connection test failed:', error);
        return false;
      }
    }
  }