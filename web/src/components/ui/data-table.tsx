import * as React from "react"
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import type {
  ColumnDef,
  ColumnFiltersState,
  SortingState,
} from "@tanstack/react-table"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const PAGE_SIZES = [10, 25, 50, 100]

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
  globalFilter?: string
  onGlobalFilterChange?: (value: string) => void
  emptyMessage?: React.ReactNode
  pageSize?: number
}

export function DataTable<TData, TValue>({
  columns,
  data,
  globalFilter = "",
  onGlobalFilterChange,
  emptyMessage = "No results found.",
  pageSize = 10,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      columnFilters,
      globalFilter,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: onGlobalFilterChange,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    initialState: {
      pagination: {
        pageSize,
      },
    },
  })

  const { pageIndex, pageSize: currentPageSize } = table.getState().pagination
  const filteredRows = table.getFilteredRowModel().rows.length
  const firstRow = filteredRows === 0 ? 0 : pageIndex * currentPageSize + 1
  const lastRow = Math.min((pageIndex + 1) * currentPageSize, filteredRows)

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border/60 overflow-hidden">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  return (
                    <TableHead key={header.id}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-28 text-center"
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {filteredRows > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] font-mono text-muted-foreground">
          <div className="flex items-center gap-2">
            <span>
              {firstRow}–{lastRow} of {filteredRows}
            </span>
            <Select
              value={String(currentPageSize)}
              onValueChange={(val: string | null) =>
                val && table.setPageSize(Number(val))
              }
            >
              <SelectTrigger className="h-6 w-[74px] px-1.5 text-[11px]">
                <SelectValue>{() => `${currentPageSize} / page`}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size} / page
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="mr-1">
              Page {pageIndex + 1} of {Math.max(table.getPageCount(), 1)}
            </span>
            <Button
              variant="outline"
              size="xs"
              onClick={() => table.setPageIndex(0)}
              disabled={!table.getCanPreviousPage()}
              className="h-6 px-2 text-[11px]"
              title="First page"
            >
              «
            </Button>
            <Button
              variant="outline"
              size="xs"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="h-6 px-2 text-[11px]"
            >
              Prev
            </Button>
            <Button
              variant="outline"
              size="xs"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="h-6 px-2 text-[11px]"
            >
              Next
            </Button>
            <Button
              variant="outline"
              size="xs"
              onClick={() => table.setPageIndex(table.getPageCount() - 1)}
              disabled={!table.getCanNextPage()}
              className="h-6 px-2 text-[11px]"
              title="Last page"
            >
              »
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
