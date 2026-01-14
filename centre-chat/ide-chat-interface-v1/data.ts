import { Message } from './types';

export const INITIAL_MESSAGES: Message[] = [
  {
    id: 'msg_1',
    sender: 'agent',
    senderName: 'AURORA',
    timestamp: '09:31 AM',
    content: [
      {
        type: 'text',
        content: "I'll systematically test all the tools (except aurora_search and shell tools) to verify they're working correctly. Let me start by checking the current workspace state and then run through a series of tests."
      },
      {
        type: 'tools',
        actions: [
          { 
            id: 't1', 
            toolName: 'workspace_tree', 
            args: 'aurora-testing', 
            icon: 'folder_open', 
            status: 'success',
            result: "{\n  \"root\": \"aurora-testing\",\n  \"files\": 14,\n  \"directories\": 3\n}" 
          },
          { 
            id: 't2', 
            toolName: 'file_read', 
            args: 'README.md', 
            icon: 'description', 
            status: 'success',
            result: "# Aurora Testing\n\nThis is a mock readme file content initialized for testing purposes."
          }
        ]
      },
      {
        type: 'text',
        content: "Now let me test file operations - creating files and folders:"
      },
      {
        type: 'tools',
        actions: [
          { 
            id: 't3', 
            toolName: 'folder_create', 
            args: 'test_folder', 
            icon: 'create_new_folder', 
            status: 'success',
            result: "Folder 'test_folder' created successfully at /root/aurora-testing/"
          },
          { 
            id: 't4', 
            toolName: 'file_create', 
            args: 'test_file_1.txt', 
            icon: 'note_add', 
            status: 'success',
            result: "File created. Pending approval from security policy #23."
          },
          { 
            id: 't5', 
            toolName: 'file_create', 
            args: 'test_file_2.txt', 
            icon: 'note_add', 
            status: 'success',
            result: "File created. 0 bytes written."
          },
          { 
            id: 't6', 
            toolName: 'file_create', 
            args: 'test_nested.txt', 
            icon: 'note_add', 
            status: 'success',
            result: "File created inside 'test_folder'."
          }
        ]
      },
      {
        type: 'text',
        content: 'Good progress! Folder creation works. Files show "pending approval" which is expected behavior. Let me test reading and editing:'
      },
      {
        type: 'tools',
        actions: [
          { 
            id: 't7', 
            toolName: 'file_read', 
            args: 'README.md', 
            icon: 'description', 
            status: 'success',
            result: "Reading file buffer... OK."
          },
          { 
            id: 't8', 
            toolName: 'grep', 
            args: 'aurora-testing', 
            icon: 'search', 
            status: 'success',
            result: "Found 4 matches in 2 files."
          }
        ]
      },
      {
        type: 'text',
        content: "Excellent! `file_read` and `grep` work perfectly. Now testing search_replace and file_write:"
      }
    ]
  }
];