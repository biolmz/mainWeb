#!/usr/bin/env python3
import os
import json
import subprocess
from qcloud_cos import CosConfig, CosS3Client

secret_id = os.environ['COS_SECRET_ID']
secret_key = os.environ['COS_SECRET_KEY']

BUCKETS = [
    {"bucket": "lmz-1375687844", "region": "ap-nanjing"},
    {"bucket": "danaz-beijing-1375687844", "region": "ap-beijing"},
]

TYPE_MAP = {
    'pdf':  ('doc', 'pdf', 'PDF'),
    'docx': ('doc', 'docx', 'DOCX'),
    'doc':  ('doc', 'docx', 'DOC'),
    'xlsx': ('doc', 'xlsx', 'XLSX'),
    'xls':  ('doc', 'xlsx', 'XLS'),
    'pptx': ('doc', 'pptx', 'PPTX'),
    'ppt':  ('doc', 'pptx', 'PPT'),
    'zip':  ('archive', 'zip', 'ZIP'),
    'rar':  ('archive', 'zip', 'RAR'),
    '7z':   ('archive', 'zip', '7Z'),
    'mp4':  ('video', 'video', 'MP4'),
    'mov':  ('video', 'video', 'MOV'),
    'avi':  ('video', 'video', 'AVI'),
    'mp3':  ('audio', 'audio', 'MP3'),
    'wav':  ('audio', 'audio', 'WAV'),
    'flac': ('audio', 'audio', 'FLAC'),
    'png':  ('image', 'image', 'PNG'),
    'jpg':  ('image', 'image', 'JPG'),
    'jpeg': ('image', 'image', 'JPEG'),
    'gif':  ('image', 'image', 'GIF'),
    'webp': ('image', 'image', 'WEBP'),
}

def human_size(bytes_val):
    bytes_val = int(bytes_val)
    if bytes_val >= 1024**3:
        return f"{bytes_val / 1024**3:.1f} GB"
    elif bytes_val >= 1024**2:
        return f"{bytes_val / 1024**2:.1f} MB"
    elif bytes_val >= 1024:
        return f"{bytes_val / 1024:.0f} KB"
    else:
        return f"{bytes_val} B"

def scan_bucket(bucket_name, region):
    config = CosConfig(Region=region, SecretId=secret_id, SecretKey=secret_key)
    client = CosS3Client(config)

    all_files = []
    marker = ""
    while True:
        response = client.list_objects(Bucket=bucket_name, Marker=marker, MaxKeys=1000)
        contents = response.get("Contents", [])
        for obj in contents:
            key = obj["Key"]
            if key.endswith('/'):
                continue
            size = int(obj["Size"])
            if size == 0:
                continue

            ext = key.split('.')[-1].lower() if '.' in key else ''
            cat, icon, ext_upper = TYPE_MAP.get(ext, ('doc', 'file', ext.upper() or 'FILE'))

            all_files.append({
                "name": key,
                "size": human_size(size),
                "date": obj.get("LastModified", "")[:10],
                "cat": cat,
                "icon": icon,
                "ext": ext_upper,
                "url": f"https://{bucket_name}.cos.{region}.myqcloud.com/{key}"
            })

        if response.get("IsTruncated") == "true":
            marker = response.get("NextMarker", "")
        else:
            break

    return all_files

def main():
    all_files = []
    for cfg in BUCKETS:
        print(f"Scanning {cfg['bucket']}...")
        try:
            files = scan_bucket(cfg['bucket'], cfg['region'])
            all_files.extend(files)
            print(f"  Found {len(files)} files")
        except Exception as e:
            print(f"  Error: {e}")

    # 按日期倒序
    all_files.sort(key=lambda x: x['date'], reverse=True)

    # 写入临时文件，和现有 files.json 对比
    tmp_path = "files.json.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(all_files, f, ensure_ascii=False, indent=2)

    # 检查是否有变化
    try:
        with open("files.json", "r", encoding="utf-8") as f:
            existing = f.read()
        with open(tmp_path, "r", encoding="utf-8") as f:
            new_content = f.read()

        if existing == new_content:
            print("No changes detected, skipping commit")
            os.remove(tmp_path)
            return
    except FileNotFoundError:
        pass  # files.json 不存在，需要写入

    # 有变化，替换 files.json
    os.replace(tmp_path, "files.json")
    print(f"Updated {len(all_files)} files -> files.json")

if __name__ == "__main__":
    main()